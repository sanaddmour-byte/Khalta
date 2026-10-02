import { sql } from 'drizzle-orm';
import { runMigrations } from '@khalta/db';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestEnv, type TestEnv } from './helpers';

let env: TestEnv;
beforeAll(async () => {
  env = await createTestEnv();
});
afterAll(() => env.close());

describe('migrations', () => {
  it('are idempotent and create the expected foundation tables', async () => {
    await runMigrations(env.config.DATABASE_URL);
    await runMigrations(env.config.DATABASE_URL);
    const res = await env.db.execute(
      sql`select table_name from information_schema.tables where table_schema = 'public'`,
    );
    const names = res.rows.map((r) => r['table_name']);
    for (const t of [
      'tenants',
      'users',
      'sessions',
      'accounts',
      'verifications',
      'plants',
      'user_plants',
      'suppliers',
      'tenant_settings',
      'audit_log',
    ])
      expect(names).toContain(t);
  });

  it('uses timestamptz everywhere and money-safe numeric', async () => {
    const res = await env.db.execute(
      sql`select table_name, column_name, data_type from information_schema.columns where table_schema='public' and (data_type like 'timestamp%' or column_name like '%jod%')`,
    );
    for (const r of res.rows) {
      if (String(r['column_name']).includes('jod')) expect(r['data_type']).toBe('numeric');
      else
        expect(r['data_type'], `${r['table_name']}.${r['column_name']}`).toBe(
          'timestamp with time zone',
        );
    }
  });
});

describe('OpenAPI', () => {
  it('documents every declared route and requires authentication', async () => {
    const admin = await env.login((await env.seedUser('admin')).email);
    const doc = (await admin.get('/api/openapi.json')).body;
    expect(doc.openapi).toBe('3.1.0');
    for (const r of env.app.api.routes) {
      const p = r.path.replace(/:(\w+)/g, '{$1}');
      expect(doc.paths[p]?.[r.method.toLowerCase()], `${r.method} ${r.path}`).toBeDefined();
    }
    expect(doc.paths['/api/users'].post.requestBody).toBeDefined();
  });

  it('health is public and exposes no framework header', async () => {
    const res = await (await import('supertest')).default(env.app).get('/health');
    expect(res.body).toEqual({ status: 'ok' });
    expect(res.headers['x-powered-by']).toBeUndefined();
  });
});

describe('logging', () => {
  it('never writes session cookies or credentials to logs', async () => {
    const { Writable } = await import('node:stream');
    const request = (await import('supertest')).default;
    const { createApp } = await import('../src/app');
    const { createLogger } = await import('../src/logger');
    const lines: string[] = [];
    const sink = new Writable({
      write(chunk, _enc, cb) {
        lines.push(String(chunk));
        cb();
      },
    });
    const u = await env.seedUser('viewer');
    const app = createApp({
      config: env.config,
      db: env.db,
      auth: env.auth,
      logger: createLogger({ LOG_LEVEL: 'info' }, sink),
    });
    const agent = request.agent(app);
    const login = await agent
      .post('/api/auth/sign-in/email')
      .send({ email: u.email, password: 'correct-horse-battery-staple' });
    const token = String((login.headers['set-cookie'] as unknown as string[])[0])
      .split('=')[1]!
      .split(';')[0]!;
    await agent.get('/api/me');
    const out = lines.join('');
    expect(out).toContain('request completed');
    expect(out).toContain('[redacted]');
    expect(out).not.toContain(token);
    expect(out).not.toContain('correct-horse');
  });
});

describe('static web hosting (ADR 0006)', () => {
  it('serves the built app from the same origin without shadowing the API', async () => {
    const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'khalta-web-'));
    mkdirSync(join(dir, 'assets'));
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>spa</title>');
    writeFileSync(join(dir, 'assets', 'a.js'), 'console.log(1)');
    const env2 = await createTestEnv({ WEB_DIST_DIR: dir });
    try {
      const get = (p: string) => request(env2.app).get(p);
      expect((await get('/login')).text).toContain('<title>spa</title>'); // client-side route
      const asset = await get('/assets/a.js');
      expect(asset.headers['cache-control']).toMatch(/immutable/);
      expect((await get('/')).headers['cache-control']).toBe('no-cache');
      expect((await get('/health')).body).toEqual({ status: 'ok' });
      const missingApi = await get('/api/nope');
      expect(missingApi.status).toBe(401); // the API answers (JSON), never the app shell
      expect(missingApi.body.error.code).toBe('unauthenticated');
      expect((await get('/api/me')).status).toBe(401); // still guarded
    } finally {
      await env2.close();
    }
  });
});

describe('/api/me instance flags', () => {
  it('reports the demo flag from KHALTA_DEMO', async () => {
    const u = await env.seedUser('viewer');
    const agent = await env.login(u.email);
    expect((await agent.get('/api/me')).body.instance).toEqual({ demo: false });
    process.env['KHALTA_DEMO'] = '1';
    try {
      expect((await agent.get('/api/me')).body.instance).toEqual({ demo: true });
    } finally {
      delete process.env['KHALTA_DEMO'];
    }
  });
});
