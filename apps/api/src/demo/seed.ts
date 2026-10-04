import { schema, type Db } from '@khalta/db';
import { ROLES } from '@khalta/rbac';
import { addDays, todayAmman } from '@khalta/engine';
import { eq, like } from 'drizzle-orm';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../app';
import type { Auth } from '../auth';
import type { Config } from '../config';
import { insertUserWithPassword } from '../routes/users';
import { buildDemoPlan, DEMO_MARKER_CODE, SYNTHETIC } from './plan';
import { applyDemoRuleValues } from './rules';

/** A tiny cookie-keeping HTTP client: the demo is created through the same API the UI uses. */
export class Client {
  private cookie = '';
  constructor(
    private base: string,
    private origin: string,
  ) {}
  async call<T = unknown>(method: string, path: string, body?: unknown, raw?: Buffer): Promise<T> {
    const res = await fetch(`${this.base}${path}`, {
      method,
      headers: {
        origin: this.origin,
        ...(this.cookie && { cookie: this.cookie }),
        ...(body !== undefined && { 'content-type': 'application/json' }),
        ...(raw && { 'content-type': 'application/octet-stream' }),
      },
      body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
    });
    const set = res.headers.getSetCookie?.() ?? [];
    if (set.length) this.cookie = set.map((c) => c.split(';')[0]).join('; ');
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text.slice(0, 400)}`);
    return (text ? JSON.parse(text) : undefined) as T;
  }
  get = <T>(p: string) => this.call<T>('GET', p);
  post = <T>(p: string, b: unknown) => this.call<T>('POST', p, b);
  patch = <T>(p: string, b: unknown) => this.call<T>('PATCH', p, b);
  put = <T>(p: string, b: unknown) => this.call<T>('PUT', p, b);
  upload = <T>(p: string, buf: Buffer) => this.call<T>('POST', p, undefined, buf);
}

const mulberry = (seed: number) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const SYNTHETIC_PDF = Buffer.from(`%PDF-1.4\n% ${SYNTHETIC} lab report, not a real document\n`);

export interface SeedDeps {
  db: Db;
  auth: Auth;
  config: Config;
  tenantId: string;
  password: string;
  log?: (m: string) => void;
}

/** Creates the Appendix C demo dataset. Idempotent: does nothing when the marker design already exists. */
export async function seedDemo(d: SeedDeps): Promise<{ skipped: boolean; designs: number }> {
  const log = d.log ?? (() => undefined);
  const [marker] = await d.db
    .select({ id: schema.mixDesigns.id })
    .from(schema.mixDesigns)
    .where(eq(schema.mixDesigns.code, DEMO_MARKER_CODE));
  if (marker) return { skipped: true, designs: 0 };
  const plan = buildDemoPlan();

  // users: one per role (+ a second QC manager so four-eyes attestation works)
  const emailOf = (role: string, n = 1) => `${role.replace('_', '.')}${n > 1 ? n : ''}@khalta.test`;
  const wanted = [...ROLES.map((r) => ({ role: r, n: 1 })), { role: 'qc_manager', n: 2 }];
  const userIds: Record<string, string> = {};
  for (const w of wanted) {
    const email = emailOf(w.role, w.n);
    const [u] = await d.db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.email, email));
    if (u) {
      userIds[email] = u.id;
      continue;
    }
    userIds[email] = await d.db.transaction((tx) =>
      insertUserWithPassword(tx, d.auth, {
        tenantId: d.tenantId,
        email,
        name: `${w.role}${w.n > 1 ? ' 2' : ''}`,
        role: w.role,
        password: d.password,
        createdBy: null,
      }),
    );
  }

  const app = createApp({ config: d.config, db: d.db, auth: d.auth });
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const login = async (email: string) => {
      const c = new Client(base, d.config.BETTER_AUTH_URL);
      await c.post('/api/auth/sign-in/email', { email, password: d.password });
      return c;
    };
    const admin = await login(emailOf('admin'));
    const mgr = await login(emailOf('qc_manager'));
    const mgr2 = await login(emailOf('qc_manager', 2));
    const today = todayAmman();

    // plants and who may see them
    const plants = await admin.get<{ id: string; code: string }[]>('/api/plants');
    const plantId: Record<string, string> = Object.fromEntries(plants.map((p) => [p.code, p.id]));
    for (const p of plan.plants)
      if (!plantId[p.code])
        plantId[p.code] = (
          await admin.post<{ id: string }>('/api/plants', {
            code: p.code,
            nameEn: p.nameEn,
            nameAr: p.nameAr,
            city: p.city,
            ambientProfile: p.ambientProfile,
          })
        ).id;
    const users = await admin.get<{ id: string; email: string; role: string }[]>('/api/users');
    for (const u of users.filter(
      (x) => x.email.endsWith('@khalta.test') && !['admin', 'qc_manager'].includes(x.role),
    ))
      await admin.put(`/api/users/${u.id}/plants`, {
        plantIds: u.role === 'plant_manager' ? [plantId['AMM-01']!] : Object.values(plantId),
      });
    log('plants and users ready');

    // demo-only synthetic limits (unverified; the real seeds stay null)
    await admin.patch('/api/settings', { stalePriceDays: plan.settings.stalePriceDays });
    const rules = (await admin.get<{ rules: { id: string; key: string }[] }>('/api/rules')).rules;
    for (const cat of ['cement', 'scm', 'fine_agg', 'coarse_agg', 'admixture']) {
      const rule = rules.find((x) => x.key === `eng.test_age_limit_days.${cat}`);
      if (rule)
        await admin.patch(`/api/rules/${rule.id}/value`, {
          value: plan.settings.testAgeLimitDays,
          reason: `${SYNTHETIC} demo-only test-age limit`,
        });
    }

    const supplierId: Record<string, string> = {};
    for (const s of plan.suppliers)
      supplierId[s.nameEn] = (await mgr.post<{ id: string }>('/api/suppliers', s)).id;

    const matId: Record<string, string> = {};
    for (const m of plan.materials) {
      const created = await mgr.post<{ id: string }>('/api/materials', {
        category: m.category,
        marketNameAr: m.nameAr,
        marketNameEn: m.nameEn,
        supplierId: supplierId[m.supplier],
        ...(m.plant && { plantId: plantId[m.plant] }),
        notes: `${SYNTHETIC}: demo data, not a real material`,
      });
      matId[m.key] = created.id;
      const att =
        m.source === 'lab_report'
          ? await mgr.upload<{ id: string }>(
              `/api/attachments?filename=${encodeURIComponent('synthetic-lab-report.pdf')}`,
              SYNTHETIC_PDF,
            )
          : null;
      await mgr.post(`/api/materials/${created.id}/tests`, {
        properties: m.properties,
        source: m.source,
        testedAt: addDays(today, -m.testedDaysAgo),
        labRef: `${SYNTHETIC}-${m.key}`,
        ...(att && { attachmentId: att.id }),
        ...(m.source === 'user_declared' && { declaredReason: `${SYNTHETIC} demo value` }),
      });
    }
    log(`${plan.materials.length} materials with tests`);

    // two price waves (history) and two snapshots
    const entries = (wave: 1 | 2) =>
      plan.prices.flatMap((p) => {
        const price = wave === 1 ? p.wave1 : p.wave2;
        return price
          ? [
              {
                materialId: matId[p.material]!,
                plantId: plantId[p.plant]!,
                supplierId: supplierId[p.supplier]!,
                price,
                unit: p.unit,
              },
            ]
          : [];
      });
    await admin.post('/api/prices', {
      entries: entries(1),
      effectiveFrom: addDays(today, -120),
      reason: `${SYNTHETIC} initial price list`,
    });
    await admin.post('/api/price-snapshots', {
      name: `Baseline (${SYNTHETIC})`,
      asOf: addDays(today, -100),
    });
    await admin.post('/api/prices', {
      entries: entries(2),
      effectiveFrom: addDays(today, -10),
      reason: `${SYNTHETIC} new supplier tariff`,
    });
    await admin.post('/api/price-snapshots', { name: `Current (${SYNTHETIC})` });
    log('prices and snapshots');

    // legacy designs through the real import, then attestation by the second QC manager
    const up = await mgr.upload<{ batchId: string }>(
      `/api/imports/legacy/upload?filename=${encodeURIComponent('demo-legacy-designs.csv')}`,
      Buffer.from(plan.legacyCsv),
    );
    const imported = await mgr.post<{ designs: number }>(
      `/api/imports/legacy/${up.batchId}/commit`,
      {},
    );
    const designs = await mgr.get<{ id: string; code: string }[]>('/api/designs?q=DEMO-');
    for (const spec of plan.designs.filter((x) => x.attest)) {
      const row = designs.find((x) => x.code === spec.code)!;
      await mgr2.post(`/api/designs/${row.id}/attest`, {
        approvalReference: `${SYNTHETIC} submittal ${spec.code}`,
        inProduction: true,
        note: `${SYNTHETIC} attestation for the demo`,
      });
    }
    log(
      `${imported.designs} legacy designs, ${plan.designs.filter((x) => x.attest).length} attested`,
    );

    // flag the designs and add six months of volumes (synthetic)
    await d.db
      .update(schema.mixDesigns)
      .set({ synthetic: true })
      .where(like(schema.mixDesigns.code, 'DEMO-%'));
    const rnd = mulberry(plan.seed + 1);
    const volumes = designs.flatMap((row) => {
      const spec = plan.designs.find((x) => x.code === row.code)!;
      return Array.from({ length: 6 }, (_, i) => {
        const dt = new Date(`${today}T00:00:00Z`);
        dt.setUTCMonth(dt.getUTCMonth() - (i + 1), 1);
        return {
          tenantId: d.tenantId,
          designId: row.id,
          plantId: plantId[spec.plant]!,
          month: dt.toISOString().slice(0, 10),
          volumeM3: (spec.avgMonthly * (0.85 + rnd() * 0.3)).toFixed(2),
          source: 'demo' as const,
        };
      });
    });
    await d.db.insert(schema.productionVolumes).values(volumes);
    return { skipped: false, designs: imported.designs };
  } finally {
    await new Promise((r) => server.close(r));
  }
}

/** Fills the empty rule values with the SYNTHETIC demo set (see rules.ts). Idempotent; safe to run on every start. */
export async function seedDemoRules(d: SeedDeps): Promise<number> {
  const app = createApp({ config: d.config, db: d.db, auth: d.auth });
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const admin = new Client(base, d.config.BETTER_AUTH_URL);
    await admin.post('/api/auth/sign-in/email', {
      email: 'admin@khalta.test',
      password: d.password,
    });
    return await applyDemoRuleValues(admin, d.log);
  } finally {
    await new Promise((r) => server.close(r));
  }
}
