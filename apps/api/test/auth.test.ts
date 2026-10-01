import { schema } from '@khalta/db';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';
import { createTestEnv, PASSWORD, testEnv, type TestEnv } from './helpers';

let env: TestEnv;
beforeAll(async () => {
  env = await createTestEnv();
});
afterAll(() => env.close());

describe('authentication', () => {
  it('rejects unauthenticated API access', async () => {
    for (const path of ['/api/me', '/api/plants', '/api/users', '/api/openapi.json'])
      expect((await request(env.app).get(path)).status).toBe(401);
  });

  it('signs in, sets an httpOnly SameSite=Lax cookie and serves /api/me', async () => {
    const u = await env.seedUser('qc_engineer');
    const res = await request(env.app)
      .post('/api/auth/sign-in/email')
      .send({ email: u.email, password: PASSWORD });
    expect(res.status).toBe(200);
    const cookie = (res.headers['set-cookie'] as unknown as string[]).join(';');
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    const me = await (await env.login(u.email)).get('/api/me');
    expect(me.status).toBe(200);
    expect(me.body.role).toBe('qc_engineer');
    expect(me.body.user.email).toBe(u.email);
  });

  it('rejects wrong password and unknown user identically', async () => {
    const u = await env.seedUser('viewer');
    const bad = await request(env.app)
      .post('/api/auth/sign-in/email')
      .send({ email: u.email, password: 'x'.repeat(14) });
    const none = await request(env.app)
      .post('/api/auth/sign-in/email')
      .send({ email: 'nobody@example.test', password: 'x'.repeat(14) });
    expect(bad.status).toBe(401);
    expect(none.status).toBe(401);
    expect(bad.body).toEqual(none.body);
  });

  it('signs out and invalidates the session', async () => {
    const u = await env.seedUser('viewer');
    const agent = await env.login(u.email);
    expect((await agent.get('/api/me')).status).toBe(200);
    expect((await agent.post('/api/auth/sign-out').send({})).status).toBe(200);
    expect((await agent.get('/api/me')).status).toBe(401);
  });

  it('keeps public sign-up and every non-allowlisted auth endpoint closed', async () => {
    const admin = await env.seedUser('admin');
    const agent = await env.login(admin.email);
    for (const path of [
      '/api/auth/sign-up/email',
      '/api/auth/admin/create-user',
      '/api/auth/admin/list-users',
      '/api/auth/change-password',
      '/api/auth/reset-password',
    ]) {
      const res = await agent
        .post(path)
        .send({ email: 'x@example.test', password: PASSWORD, name: 'x' });
      expect(res.status, path).toBe(404);
    }
    expect(
      await env.db.select().from(schema.users).where(eq(schema.users.email, 'x@example.test')),
    ).toHaveLength(0);
  });

  it('treats an expired session as unauthenticated', async () => {
    const u = await env.seedUser('viewer');
    const agent = await env.login(u.email);
    await env.db
      .update(schema.sessions)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(schema.sessions.userId, u.id));
    expect((await agent.get('/api/me')).status).toBe(401);
  });

  it('blocks browser mutations from a foreign origin but allows our own', async () => {
    const admin = await env.seedUser('admin');
    const agent = await env.login(admin.email);
    const foreign = await agent
      .patch('/api/settings')
      .set('Origin', 'https://evil.example')
      .send({ maxPlants: 5 });
    expect(foreign.status).toBe(403);
    const own = await agent
      .patch('/api/settings')
      .set('Origin', 'http://localhost:5173')
      .send({ maxPlants: 20 });
    expect(own.status).toBe(200);
  });

  it('refuses invalid JSON and unknown routes with JSON errors', async () => {
    const admin = await env.seedUser('admin');
    const agent = await env.login(admin.email);
    const bad = await agent
      .patch('/api/settings')
      .set('Content-Type', 'application/json')
      .send('{oops');
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('invalid_json');
    expect((await agent.get('/api/nope')).status).toBe(404);
  });
});

describe('configuration', () => {
  it('fails fast on a short or missing secret, never defaulting', () => {
    expect(() => loadConfig({ ...testEnv('postgres://x'), BETTER_AUTH_SECRET: 'short' })).toThrow(
      /BETTER_AUTH_SECRET/,
    );
    expect(() => loadConfig({ ...testEnv('postgres://x'), BETTER_AUTH_SECRET: undefined })).toThrow(
      /Invalid configuration/,
    );
  });
});
