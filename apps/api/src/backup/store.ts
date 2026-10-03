// Where backups live: an S3-compatible bucket (production) or a directory (tests, the restore drill). Keys are
// plain `a/b/c` strings; both adapters refuse anything that could leave the root.
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, readdir, rm, stat, writeFile, copyFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';

export interface StoredObject {
  key: string;
  size: number;
  lastModified: Date;
}
export interface BackupStore {
  kind: 's3' | 'dir';
  describe(): string;
  putFile(key: string, path: string): Promise<void>;
  putText(key: string, text: string): Promise<void>;
  getFile(key: string, dest: string): Promise<void>;
  getText(key: string): Promise<string>;
  list(prefix: string): Promise<StoredObject[]>;
  delete(keys: string[]): Promise<void>;
}

const SAFE_KEY = /^[A-Za-z0-9._\-/=]+$/;
export function assertKey(key: string) {
  if (!SAFE_KEY.test(key) || key.startsWith('/') || key.split('/').includes('..'))
    throw new Error(`unsafe backup key: ${key}`);
}

export class DirStore implements BackupStore {
  readonly kind = 'dir' as const;
  private readonly root: string;
  constructor(root: string) {
    this.root = resolve(root);
  }
  describe() {
    return `dir:${this.root}`;
  }
  private path(key: string) {
    assertKey(key);
    const p = resolve(join(this.root, key));
    if (!p.startsWith(this.root + sep)) throw new Error(`unsafe backup key: ${key}`);
    return p;
  }
  async putFile(key: string, path: string) {
    const p = this.path(key);
    await mkdir(dirname(p), { recursive: true });
    await copyFile(path, p);
  }
  async putText(key: string, text: string) {
    const p = this.path(key);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, text, 'utf8');
  }
  async getFile(key: string, dest: string) {
    await mkdir(dirname(dest), { recursive: true });
    await pipeline(createReadStream(this.path(key)), createWriteStream(dest));
  }
  async getText(key: string) {
    return readFile(this.path(key), 'utf8');
  }
  async list(prefix: string) {
    const out: StoredObject[] = [];
    const walk = async (dir: string) => {
      let names: string[];
      try {
        names = await readdir(dir);
      } catch {
        return;
      }
      for (const n of names) {
        const full = join(dir, n);
        const st = await stat(full);
        if (st.isDirectory()) await walk(full);
        else {
          const key = full
            .slice(this.root.length + 1)
            .split(sep)
            .join('/');
          if (key.startsWith(prefix)) out.push({ key, size: st.size, lastModified: st.mtime });
        }
      }
    };
    await walk(this.root);
    return out.sort((a, b) => a.key.localeCompare(b.key));
  }
  async delete(keys: string[]) {
    for (const k of keys) await rm(this.path(k), { force: true });
  }
}

export interface S3Settings {
  bucket: string;
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export class S3Store implements BackupStore {
  readonly kind = 's3' as const;
  private readonly client: S3Client;
  constructor(private readonly s: S3Settings) {
    this.client = new S3Client({
      endpoint: s.endpoint,
      region: s.region,
      forcePathStyle: true,
      credentials: { accessKeyId: s.accessKeyId, secretAccessKey: s.secretAccessKey },
    });
  }
  describe() {
    return `s3:${this.s.endpoint}/${this.s.bucket}`;
  }
  async putFile(key: string, path: string) {
    assertKey(key);
    const st = await stat(path);
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.s.bucket,
        Key: key,
        Body: createReadStream(path),
        ContentLength: st.size,
        ContentType: 'application/octet-stream',
      }),
    );
  }
  async putText(key: string, text: string) {
    assertKey(key);
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.s.bucket,
        Key: key,
        Body: Buffer.from(text, 'utf8'),
        ContentType: 'application/json',
      }),
    );
  }
  async getFile(key: string, dest: string) {
    assertKey(key);
    const r = await this.client.send(new GetObjectCommand({ Bucket: this.s.bucket, Key: key }));
    await mkdir(dirname(dest), { recursive: true });
    await pipeline(r.Body as Readable, createWriteStream(dest));
  }
  async getText(key: string) {
    assertKey(key);
    const r = await this.client.send(new GetObjectCommand({ Bucket: this.s.bucket, Key: key }));
    return (await r.Body!.transformToString('utf8')) as string;
  }
  async list(prefix: string) {
    const out: StoredObject[] = [];
    let token: string | undefined;
    do {
      const r = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.s.bucket,
          Prefix: prefix,
          ContinuationToken: token,
        }),
      );
      for (const o of r.Contents ?? [])
        out.push({ key: o.Key!, size: o.Size ?? 0, lastModified: o.LastModified ?? new Date(0) });
      token = r.IsTruncated ? r.NextContinuationToken : undefined;
    } while (token);
    return out.sort((a, b) => a.key.localeCompare(b.key));
  }
  async delete(keys: string[]) {
    for (let i = 0; i < keys.length; i += 500)
      await this.client.send(
        new DeleteObjectsCommand({
          Bucket: this.s.bucket,
          Delete: { Objects: keys.slice(i, i + 500).map((Key) => ({ Key })) },
        }),
      );
  }
}
