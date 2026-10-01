import { sql } from 'drizzle-orm';
import { runMigrations } from '@khalta/db';
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
