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
  async call<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
    raw?: Buffer,
    attempt = 0,
  ): Promise<T> {
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
    // The sign-in route is rate limited (a handful per ten seconds). A seeding run signs in as several roles, so it
    // waits out the limit instead of failing: this is a one-off tool, never a request path.
    if (res.status === 429 && attempt < 6) {
      const wait = Number(res.headers.get('x-retry-after') ?? res.headers.get('retry-after') ?? 10);
      await new Promise((r) => setTimeout(r, (Number.isFinite(wait) ? wait : 10) * 1000 + 500));
      return this.call<T>(method, path, body, raw, attempt + 1);
    }
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
    const rules = (await mgr.get<{ rules: { id: string; key: string }[] }>('/api/rules')).rules;
    for (const cat of ['cement', 'scm', 'fine_agg', 'coarse_agg', 'admixture']) {
      const rule = rules.find((x) => x.key === `eng.test_age_limit_days.${cat}`);
      if (rule)
        await mgr.patch(`/api/rules/${rule.id}/value`, {
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
    // rule values are engineering values: written by the QC manager, never by the admin (ADR 0020)
    const mgr = new Client(base, d.config.BETTER_AUTH_URL);
    await mgr.post('/api/auth/sign-in/email', {
      email: 'qc.manager@khalta.test',
      password: d.password,
    });
    return await applyDemoRuleValues(mgr, d.log);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

const canon = (v: unknown): unknown => {
  if (Array.isArray(v))
    return v.map(canon).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  if (v && typeof v === 'object')
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, x]) => [k, canon(x)]),
    );
  return v;
};
const same = (a: unknown, b: unknown) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));

/**
 * Brings an EXISTING demo database in line with the current demo plan (the full seed is skipped once the marker
 * design exists): a demo material whose current test lacks or differs on any field of the plan gets a new test
 * version, and a demo price whose unit differs gets a new price row. Idempotent. Returns how many were changed.
 */
export async function upgradeDemoData(d: SeedDeps): Promise<number> {
  const log = d.log ?? (() => undefined);
  const plan = buildDemoPlan();
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
    const admin = await login('admin@khalta.test');
    const mgr = await login('qc.manager@khalta.test');
    const today = todayAmman();
    let changed = 0;

    const mats = await admin.get<{ id: string; marketNameEn: string }[]>('/api/materials');
    const idOf = new Map(mats.map((m) => [m.marketNameEn, m.id]));
    for (const m of plan.materials) {
      const id = idOf.get(m.nameEn);
      if (!id) continue;
      const cur = await admin.get<{
        current: { properties: Record<string, unknown>; testedAt?: string } | null;
      }>(`/api/materials/${id}`);
      const have = cur.current?.properties ?? {};
      // a test the plan no longer expires (an earlier plan expired Aqaba's second sand, which made every pumpable
      // request there infeasible) gets a fresh version; one the plan still expires is left alone
      const testedAt = (cur.current as { testedAt?: string } | null)?.testedAt;
      const expiredButShouldNot =
        !!testedAt && m.testedDaysAgo < 300 && testedAt < addDays(today, -300);
      const stale =
        expiredButShouldNot || Object.entries(m.properties).some(([k, v]) => !same(v, have[k]));
      if (!stale) continue;
      // A re-test with the same values is refused ("nothing changed"), so a refresh is recorded as a lab report
      // (its source differs from the data sheet), with a synthetic report attached.
      const asLab = expiredButShouldNot || m.source === 'lab_report';
      const att = asLab
        ? await mgr.upload<{ id: string }>(
            `/api/attachments?filename=${encodeURIComponent('synthetic-lab-report.pdf')}`,
            SYNTHETIC_PDF,
          )
        : null;
      await mgr.post(`/api/materials/${id}/tests`, {
        properties: m.properties,
        source: asLab ? 'lab_report' : m.source,
        testedAt: addDays(today, -m.testedDaysAgo),
        labRef: `${SYNTHETIC}-${m.key}${expiredButShouldNot ? '-retest' : ''}`,
        ...(att && { attachmentId: att.id }),
        // re-sourcing every field is what makes an otherwise identical re-test a recorded change
        ...(expiredButShouldNot && {
          fieldSources: Object.fromEntries(Object.keys(m.properties).map((k) => [k, 'lab_report'])),
        }),
        ...(!asLab &&
          m.source === 'user_declared' && { declaredReason: `${SYNTHETIC} demo value` }),
      });
      changed += 1;
    }

    // prices whose unit changed (water: JOD/m3 could not be converted to JOD/kg)
    const matIdByKey = new Map(plan.materials.map((m) => [m.key, idOf.get(m.nameEn)]));
    const grid = await admin.get<{
      cells: { materialId: string; plantId: string; unit?: string }[];
      plants: { id: string; code: string }[];
    }>('/api/prices');
    const plantIdOf = new Map(grid.plants.map((p) => [p.code, p.id]));
    const suppliers = await admin.get<{ id: string; nameEn: string }[]>('/api/suppliers');
    const supplierIdOf = new Map(suppliers.map((s) => [s.nameEn, s.id]));
    const entries = plan.prices.flatMap((p) => {
      const materialId = matIdByKey.get(p.material);
      const plantId = plantIdOf.get(p.plant);
      const supplierId = supplierIdOf.get(p.supplier);
      if (!materialId || !plantId || !supplierId) return [];
      const cell = grid.cells.find((c) => c.materialId === materialId && c.plantId === plantId);
      if (!cell || cell.unit === p.unit) return [];
      return [{ materialId, plantId, supplierId, price: p.wave2 ?? p.wave1, unit: p.unit }];
    });
    if (entries.length > 0) {
      await admin.post('/api/prices', {
        entries,
        effectiveFrom: today,
        reason: `${SYNTHETIC} price unit corrected so every price converts to JOD/kg`,
      });
      changed += entries.length;
    }
    if (changed > 0) log(`${changed} demo records upgraded to the current plan`);
    return changed;
  } finally {
    await new Promise((r) => server.close(r));
  }
}

/**
 * Adds what the current demo plan has and an EXISTING demo database lacks: materials (by name) with their tests and
 * prices, and legacy designs (by code), imported through the same wizard and attested like the first ones. Idempotent:
 * a second run finds nothing missing. Returns how many materials and designs were added.
 */
export async function topUpDemoData(d: SeedDeps): Promise<{ materials: number; designs: number }> {
  const log = d.log ?? (() => undefined);
  const plan = buildDemoPlan();
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
    const admin = await login('admin@khalta.test');
    const mgr = await login('qc.manager@khalta.test');
    const today = todayAmman();

    // ---- materials with tests, and their prices
    const have = await admin.get<{ id: string; marketNameEn: string }[]>('/api/materials');
    const idOf = new Map(have.map((m) => [m.marketNameEn, m.id]));
    const missing = plan.materials.filter((m) => !idOf.has(m.nameEn));
    const suppliers = await admin.get<{ id: string; nameEn: string }[]>('/api/suppliers');
    const supplierIdOf = new Map(suppliers.map((x) => [x.nameEn, x.id]));
    const plants = await admin.get<{ id: string; code: string }[]>('/api/plants');
    const plantIdOf = new Map(plants.map((p) => [p.code, p.id]));
    const newIds = new Map<string, string>();
    for (const m of missing) {
      const created = await mgr.post<{ id: string }>('/api/materials', {
        category: m.category,
        marketNameAr: m.nameAr,
        marketNameEn: m.nameEn,
        supplierId: supplierIdOf.get(m.supplier),
        ...(m.plant && { plantId: plantIdOf.get(m.plant) }),
        notes: `${SYNTHETIC}: demo data, not a real material`,
      });
      newIds.set(m.key, created.id);
      await mgr.post(`/api/materials/${created.id}/tests`, {
        properties: m.properties,
        source: m.source,
        testedAt: addDays(today, -m.testedDaysAgo),
        labRef: `${SYNTHETIC}-${m.key}`,
        ...(m.source === 'user_declared' && { declaredReason: `${SYNTHETIC} demo value` }),
      });
    }
    const entries = plan.prices.flatMap((p) => {
      const materialId = newIds.get(p.material);
      const plantId = plantIdOf.get(p.plant);
      const supplierId = supplierIdOf.get(p.supplier);
      const price = p.wave2 ?? p.wave1;
      return materialId && plantId && supplierId && price
        ? [{ materialId, plantId, supplierId, price, unit: p.unit }]
        : [];
    });
    if (entries.length > 0)
      await admin.post('/api/prices', {
        entries,
        effectiveFrom: addDays(today, -10),
        reason: `${SYNTHETIC} price list for the added materials`,
      });
    if (missing.length > 0) log(`${missing.length} materials added with tests and prices`);

    // ---- designs
    const existing = await mgr.get<{ code: string }[]>('/api/designs?q=DEMO-');
    const haveCodes = new Set(existing.map((x) => x.code));
    const addCodes = plan.designs.filter((x) => !haveCodes.has(x.code));
    let designsAdded = 0;
    if (addCodes.length > 0) {
      const csv = [plan.legacyHeader, ...addCodes.flatMap((x) => plan.legacyRows[x.code]!)].join(
        '\n',
      );
      const up = await mgr.upload<{ batchId: string }>(
        `/api/imports/legacy/upload?filename=${encodeURIComponent('demo-legacy-designs-2.csv')}`,
        Buffer.from(csv),
      );
      const done = await mgr.post<{ designs: number }>(
        `/api/imports/legacy/${up.batchId}/commit`,
        {},
      );
      designsAdded = done.designs;
      const mgr2 = await login('qc.manager2@khalta.test');
      const now = await mgr.get<{ id: string; code: string }[]>('/api/designs?q=DEMO-');
      for (const spec of addCodes.filter((x) => x.attest)) {
        const row = now.find((x) => x.code === spec.code);
        if (!row) continue;
        await mgr2.post(`/api/designs/${row.id}/attest`, {
          approvalReference: `${SYNTHETIC} submittal ${spec.code}`,
          inProduction: true,
          note: `${SYNTHETIC} attestation for the demo`,
        });
      }
      await d.db
        .update(schema.mixDesigns)
        .set({ synthetic: true })
        .where(like(schema.mixDesigns.code, 'DEMO-%'));
      const rnd = mulberry(plan.seed + 7);
      const rows = now
        .filter((row) => addCodes.some((x) => x.code === row.code))
        .flatMap((row) => {
          const spec = addCodes.find((x) => x.code === row.code)!;
          return Array.from({ length: 6 }, (_, i) => {
            const dt = new Date(`${today}T00:00:00Z`);
            dt.setUTCMonth(dt.getUTCMonth() - (i + 1), 1);
            return {
              tenantId: d.tenantId,
              designId: row.id,
              plantId: plantIdOf.get(spec.plant)!,
              month: dt.toISOString().slice(0, 10),
              volumeM3: (spec.avgMonthly * (0.85 + rnd() * 0.3)).toFixed(2),
              source: 'demo' as const,
            };
          });
        });
      if (rows.length) await d.db.insert(schema.productionVolumes).values(rows);
      log(`${designsAdded} legacy designs added`);
    }
    return { materials: missing.length, designs: designsAdded };
  } finally {
    await new Promise((r) => server.close(r));
  }
}
