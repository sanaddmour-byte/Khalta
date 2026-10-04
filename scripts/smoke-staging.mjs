// pnpm smoke:staging <base-url> [email password] [--require-worker]
// Checks a running Khalta instance: health, the web app, the API guard, and (with credentials) sign-in.
const [base, email, password] = process.argv.slice(2);
if (!base) {
  console.error('usage: smoke-staging <base-url> [email password]');
  process.exit(2);
}
const url = (p) => new URL(p, base).toString();
let failed = 0;
const check = async (name, fn) => {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${name}: ${e.message}`);
  }
};
const must = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

await check('/health is ok', async () => {
  const r = await fetch(url('/health'));
  must(r.ok && (await r.json()).status === 'ok', `status ${r.status}`);
});
await check('/ready: database reachable and every migration applied', async () => {
  const r = await fetch(url('/ready'));
  const b = await r.json();
  must(
    r.ok && b.status === 'ready' && b.migrations.applied === b.migrations.expected,
    `status ${r.status} ${JSON.stringify(b)}`,
  );
});
// The worker runs jobs and escalations. An API without one still serves, so this is reported, and fails only with --require-worker.
await check('the worker heartbeat is live', async () => {
  const b = await (await fetch(url('/ready'))).json();
  const state = b.worker?.state ?? 'unknown';
  if (state !== 'live') {
    if (process.argv.includes('--require-worker')) throw new Error(`worker ${state}`);
    console.log(`warn worker is ${state}: background jobs and alert escalation are not running`);
  }
});
await check('the app is served with security headers and a Content-Security-Policy', async () => {
  const r = await fetch(url('/'));
  const csp = r.headers.get('content-security-policy') ?? '';
  must(
    csp.includes("default-src 'self'") && !/script-src[^;]*unsafe-inline/.test(csp),
    `csp: ${csp}`,
  );
  must(r.headers.get('x-content-type-options') === 'nosniff', 'missing nosniff');
  must(r.headers.get('x-frame-options') === 'DENY', 'missing X-Frame-Options');
});
await check('the web app is served', async () => {
  const r = await fetch(url('/'));
  const t = await r.text();
  must(r.ok && t.includes('id="root"'), `status ${r.status}`);
});
await check('a client-side route falls back to the app', async () => {
  const r = await fetch(url('/materials'));
  must(r.ok && (await r.text()).includes('id="root"'), `status ${r.status}`);
});
await check('the API refuses anonymous requests (JSON, not the app)', async () => {
  const r = await fetch(url('/api/me'));
  must(
    r.status === 401 && (r.headers.get('content-type') ?? '').includes('json'),
    `status ${r.status}`,
  );
});
if (email && password) {
  let cookie = '';
  await check('sign-in works over the same origin', async () => {
    const r = await fetch(url('/api/auth/sign-in/email'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: new URL(base).origin },
      body: JSON.stringify({ email, password }),
    });
    must(r.ok, `status ${r.status}`);
    cookie = r.headers
      .getSetCookie()
      .map((c) => c.split(';')[0])
      .join('; ');
    must(cookie, 'no session cookie');
  });
  await check('/api/me returns the signed-in user', async () => {
    const r = await fetch(url('/api/me'), { headers: { cookie } });
    must(r.ok && (await r.json()).user?.email === email.toLowerCase(), `status ${r.status}`);
  });
  await check(
    'the role dashboard and the change-impact list respond (and anonymous calls are refused)',
    async () => {
      for (const p of ['/api/dashboard', '/api/change-impacts']) {
        must((await fetch(url(p))).status === 401, `${p} should refuse anonymous callers`);
        const r = await fetch(url(p), { headers: { cookie } });
        must(r.ok, `${p} ${r.status}`);
      }
    },
  );
  await check('rules and materials respond', async () => {
    for (const p of ['/api/rules', '/api/materials']) {
      const r = await fetch(url(p), { headers: { cookie } });
      must(r.ok, `${p} ${r.status}`);
    }
  });
}
console.log(failed ? `${failed} check(s) failed` : 'all checks passed');
process.exit(failed ? 1 : 0);
