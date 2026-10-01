// Local development data: one tenant, two plants, one user per role (password printed below).
// Refuses to run against production. Not the demo dataset (that is M1.3).
import { createDb, schema, withAudit } from '@khalta/db';
import { ROLES } from '@khalta/rbac';
import { eq } from 'drizzle-orm';
import { createAuth } from './auth';
import { bootstrap } from './bootstrap';
import { loadConfig } from './config';
import { insertUserWithPassword } from './routes/users';

const config = loadConfig();
if (config.NODE_ENV === 'production') throw new Error('dev seed refuses to run in production');
const PASSWORD = 'dev-password-change-me';

const handle = createDb(config.DATABASE_URL);
const auth = createAuth(handle.db, config);
const { tenantId } = await bootstrap(handle.db, auth, config);
const ctx = { tenantId, actor: null, requestId: 'dev-seed' };

await withAudit(handle.db, ctx, async (tx, audit) => {
  const plantIds: string[] = [];
  for (const [code, en, ar] of [
    ['AMM-01', 'Amman', 'عمّان'],
    ['AQB-01', 'Aqaba', 'العقبة'],
  ] as const) {
    const [existing] = await tx.select().from(schema.plants).where(eq(schema.plants.code, code));
    if (existing) {
      plantIds.push(existing.id);
      continue;
    }
    const [p] = await tx
      .insert(schema.plants)
      .values({ tenantId, code, nameEn: en, nameAr: ar })
      .returning();
    plantIds.push(p!.id);
    await audit.record({
      action: 'plant.create',
      entityType: 'plant',
      entityId: p!.id,
      after: { code },
    });
  }
  for (const role of ROLES) {
    const email = `${role.replace('_', '.')}@khalta.test`;
    const [existing] = await tx.select().from(schema.users).where(eq(schema.users.email, email));
    if (existing) continue;
    const id = await insertUserWithPassword(tx, auth, {
      tenantId,
      email,
      name: role,
      role,
      password: PASSWORD,
      createdBy: null,
    });
    for (const plantId of plantIds.slice(0, role === 'plant_manager' ? 1 : 2))
      await tx.insert(schema.userPlants).values({ tenantId, userId: id, plantId });
    await audit.record({
      action: 'user.create',
      entityType: 'user',
      entityId: id,
      after: { email, role },
    });
  }
  // Synthetic materials (clearly labelled; NOT real Jordanian market data).
  const [qc] = await tx
    .select()
    .from(schema.users)
    .where(eq(schema.users.email, 'qc.manager@khalta.test'));
  const sieve = (rows: [number, number][]) =>
    [150, 75, 37.5, 19]
      .map((s) => ({ sieve_mm: s, passing_pct: 100 }))
      .concat(rows.map(([s, p]) => ({ sieve_mm: s, passing_pct: p })));
  const SYNTHETIC = 'SYNTHETIC: demo data, not a real material';
  const demo: {
    en: string;
    ar: string;
    category: string;
    plant: number | null;
    props: Record<string, unknown>;
  }[] = [
    {
      en: 'Demo washed sand',
      ar: 'رمل مغسول (تجريبي)',
      category: 'fine_agg',
      plant: 0,
      props: {
        sg_ssd: 2.62,
        absorption_pct: 1.3,
        finer_75um_pct: 2.5,
        sieve_analysis: sieve([
          [9.5, 100],
          [4.75, 95],
          [2.36, 80],
          [1.18, 60],
          [0.6, 40],
          [0.3, 15],
          [0.15, 5],
        ]),
      },
    },
    {
      en: 'Demo crushed sand',
      ar: 'سيسكو (تجريبي)',
      category: 'fine_agg',
      plant: null,
      props: { sg_ssd: 2.68, absorption_pct: 1.8 },
    },
    {
      en: 'Demo coarse 20 mm',
      ar: 'عدسية 20 ملم (تجريبي)',
      category: 'coarse_agg',
      plant: null,
      props: {
        sg_ssd: 2.66,
        absorption_pct: 0.9,
        finer_75um_pct: 0.8,
        sieve_analysis: sieve([
          [25, 100],
          [19, 95],
          [12.5, 55],
          [9.5, 25],
          [4.75, 5],
          [2.36, 2],
        ]),
      },
    },
    {
      en: 'Demo cement',
      ar: 'إسمنت (تجريبي)',
      category: 'cement',
      plant: null,
      props: { sg: 3.15 },
    },
  ];
  for (const d of demo) {
    const [exists] = await tx
      .select()
      .from(schema.materials)
      .where(eq(schema.materials.marketNameEn, d.en));
    if (exists) continue;
    const [m] = await tx
      .insert(schema.materials)
      .values({
        tenantId,
        category: d.category,
        marketNameEn: d.en,
        marketNameAr: d.ar,
        notes: SYNTHETIC,
        plantId: d.plant === null ? null : plantIds[d.plant]!,
        createdBy: qc?.id ?? null,
      })
      .returning();
    const now = new Date();
    await tx.insert(schema.materialTests).values({
      tenantId,
      materialId: m!.id,
      version: 1,
      source: 'user_declared',
      fieldSources: Object.fromEntries(Object.keys(d.props).map((k) => [k, 'user_declared'])),
      properties: d.props,
      testedAt: now.toISOString().slice(0, 10),
      labRef: 'SYNTHETIC',
      declaredReason: SYNTHETIC,
      declaredBy: qc?.id ?? null,
      declaredAt: now,
      createdBy: qc?.id ?? null,
    });
    await audit.record({
      action: 'material.create',
      entityType: 'material',
      entityId: m!.id,
      after: { en: d.en, synthetic: true },
    });
  }
  // Synthetic prices (clearly labelled; NOT real market prices). Aggregates and cement at both plants.
  const [anySup] = await tx
    .select()
    .from(schema.suppliers)
    .where(eq(schema.suppliers.nameEn, 'Demo supplier (SYNTHETIC)'));
  const supplier =
    anySup ??
    (
      await tx
        .insert(schema.suppliers)
        .values({ tenantId, nameEn: 'Demo supplier (SYNTHETIC)', nameAr: 'مورد تجريبي (تجريبي)' })
        .returning()
    )[0]!;
  const synthetic: Record<string, [string, string]> = {
    'Demo cement': ['78.000', 'JOD/ton'],
    'Demo washed sand': ['9.500', 'JOD/ton'],
    'Demo crushed sand': ['8.200', 'JOD/ton'],
    'Demo coarse 20 mm': ['7.800', 'JOD/ton'],
  };
  const [hasPrice] = await tx
    .select({ id: schema.materialPrices.id })
    .from(schema.materialPrices)
    .limit(1);
  if (!hasPrice) {
    const mats = await tx.select().from(schema.materials);
    const rows = mats.flatMap((m) =>
      synthetic[m.marketNameEn]
        ? plantIds.map((plantId, i) => ({
            tenantId,
            materialId: m.id,
            plantId,
            supplierId: supplier.id,
            price: (Number(synthetic[m.marketNameEn]![0]) + i * 0.5).toFixed(3),
            unit: synthetic[m.marketNameEn]![1] as 'JOD/ton',
            effectiveFrom: new Date(Date.now() - 20 * 86_400_000).toISOString().slice(0, 10),
            reason: 'SYNTHETIC dev data',
            enteredBy: qc?.id ?? null,
          }))
        : [],
    );
    if (rows.length) {
      await tx.insert(schema.materialPrices).values(rows);
      await tx.insert(schema.pricePreferences).values(
        rows.map((r) => ({
          tenantId,
          materialId: r.materialId,
          plantId: r.plantId,
          supplierId: supplier.id,
        })),
      );
      await audit.record({
        action: 'price.set',
        entityType: 'price_batch',
        entityId: crypto.randomUUID(),
        after: { synthetic: true, rows: rows.length },
      });
    }
  }
  await audit.record({ action: 'dev_seed.run', entityType: 'tenant', entityId: tenantId });
});
console.log(
  `seeded; sign in as <role>@khalta.test (e.g. admin@khalta.test) with password "${PASSWORD}"`,
);
await handle.close();
