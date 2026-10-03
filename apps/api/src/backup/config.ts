import { z } from 'zod';
import { DirStore, S3Store, type BackupStore } from './store';

/** The slice of the environment backups need (the CLI loads this without the web app's secrets). */
export const backupEnv = z.object({
  DATABASE_URL: z.string().min(1),
  BACKUP_ENABLED: z.enum(['0', '1']).default('1'),
  BACKUP_ENV: z.string().min(1).default('local'),
  BACKUP_BUCKET_NAME: z.string().optional(),
  BACKUP_BUCKET_ENDPOINT: z.url().optional(),
  BACKUP_BUCKET_REGION: z.string().default('auto'),
  BACKUP_BUCKET_ACCESS_KEY_ID: z.string().optional(),
  BACKUP_BUCKET_SECRET_ACCESS_KEY: z.string().optional(),
  BACKUP_DIR: z.string().optional(),
  APP_VERSION: z.string().optional(),
});
export type BackupEnv = z.infer<typeof backupEnv>;

export function loadBackupEnv(env: NodeJS.ProcessEnv = process.env): BackupEnv {
  const p = backupEnv.safeParse(env);
  if (!p.success)
    throw new Error(
      `Invalid backup configuration:\n${p.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n')}`,
    );
  return p.data;
}

/** The configured store: a bucket when all four bucket variables are set, else a directory, else none. */
export function storeFrom(c: BackupEnv): BackupStore | null {
  if (
    c.BACKUP_BUCKET_NAME &&
    c.BACKUP_BUCKET_ENDPOINT &&
    c.BACKUP_BUCKET_ACCESS_KEY_ID &&
    c.BACKUP_BUCKET_SECRET_ACCESS_KEY
  )
    return new S3Store({
      bucket: c.BACKUP_BUCKET_NAME,
      endpoint: c.BACKUP_BUCKET_ENDPOINT,
      region: c.BACKUP_BUCKET_REGION,
      accessKeyId: c.BACKUP_BUCKET_ACCESS_KEY_ID,
      secretAccessKey: c.BACKUP_BUCKET_SECRET_ACCESS_KEY,
    });
  if (c.BACKUP_DIR) return new DirStore(c.BACKUP_DIR);
  return null;
}
