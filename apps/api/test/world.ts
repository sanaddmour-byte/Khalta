// Shared test world for evaluation-related API tests: a plant with five materials (tests + prices) and a
// design factory. Numbers match the SYNTHETIC fixtures in the engine package.
import { schema } from '@khalta/db';
import type { TestEnv } from './helpers';

const SIEVE = (rows: Record<string, number>) =>
  Object.entries(rows).map(([sieve_mm, passing_pct]) => ({
    sieve_mm: Number(sieve_mm),
    passing_pct,
  }));
export const TESTS: Record<
  string,
  { category: string; props: Record<string, unknown>; price: [string, string] }
> = {
  cem: { category: 'cement', props: { sg: 3.15, c3a_pct: 7.5 }, price: ['75', 'JOD/ton'] },
  sand: {
    category: 'fine_agg',
    props: {
      sg_ssd: 2.6,
      absorption_pct: 1.5,
      chlorides_pct: 0.01,
      sieve_analysis: SIEVE({
        '9.5': 100,
        '4.75': 98,
        '2.36': 80,
        '1.18': 55,
        '0.6': 35,
        '0.3': 15,
        '0.15': 5,
      }),
    },
    price: ['8', 'JOD/ton'],
  },
  coarse: {
    category: 'coarse_agg',
    props: {
      sg_ssd: 2.65,
      absorption_pct: 1,
      chlorides_pct: 0.005,
      sieve_analysis: SIEVE({ '25': 100, '19': 95, '12.5': 40, '9.5': 15, '4.75': 3, '2.36': 0 }),
    },
    price: ['7', 'JOD/ton'],
  },
  water: {
    category: 'water',
    props: { sg: 1, sg_confirmed: true, chloride_mg_l: 200 },
    price: ['0.5', 'JOD/ton'],
  },
  sp: {
    category: 'admixture',
    props: {
      type: 'F',
      sg: 1.08,
      solids_pct: 40,
      chloride_pct: 0.05,
      min_dosage_pct: 0.4,
      max_dosage_pct: 1.5,
      water_convention: 'liquid_counts_as_water',
      water_reduction_table: [
        { dosage_pct: 0.4, water_reduction_pct: 8 },
        { dosage_pct: 0.8, water_reduction_pct: 14 },
        { dosage_pct: 1.5, water_reduction_pct: 22 },
      ],
    },
    price: ['1200', 'JOD/ton'],
  },
};
export const LINES: Record<string, string> = {
  cem: '350.000',
  water: '175.000',
  sp: '3.500',
  sand: '780.000',
  coarse: '1035.000',
};
export const REQ = {
  fcMpa: 30,
  basis: 'cylinder',
  testAgeDays: 28,
  exposure: ['F0', 'S0', 'W0', 'C1'],
  slumpMm: 100,
  nmasMm: 19,
  pumpable: true,
  airPct: 2,
};

let n = 0;
export async function makeSupplier(env: TestEnv) {
  const [s] = await env.db
    .insert(schema.suppliers)
    .values({ tenantId: env.tenantId, nameAr: 'مورد', nameEn: 'Supplier' })
    .returning();
  return s!.id;
}

export async function makeWorld(env: TestEnv, supplierId: string, code: string) {
  const plant = await env.seedPlant(code);
  const mat: Record<string, string> = {};
  for (const [key, t] of Object.entries(TESTS)) {
    const [m] = await env.db
      .insert(schema.materials)
      .values({
        tenantId: env.tenantId,
        plantId: plant.id,
        category: t.category,
        marketNameEn: `${code} ${key}`,
        marketNameAr: `${key} ${code}`,
      })
      .returning();
    mat[key] = m!.id;
    await env.db.insert(schema.materialTests).values({
      tenantId: env.tenantId,
      materialId: m!.id,
      version: 1,
      isCurrent: true,
      source: 'supplier_datasheet',
      properties: t.props,
      testedAt: '2026-08-01',
    });
    await env.db.insert(schema.materialPrices).values({
      tenantId: env.tenantId,
      materialId: m!.id,
      plantId: plant.id,
      supplierId,
      price: t.price[0],
      unit: t.price[1] as 'JOD/ton',
      effectiveFrom: '2026-01-01',
    });
  }
  const design = async (
    over: Partial<typeof schema.mixDesigns.$inferInsert> = {},
    lines: Record<string, string> = LINES,
  ) => {
    const [d] = await env.db
      .insert(schema.mixDesigns)
      .values({
        tenantId: env.tenantId,
        code: `${code}-D${++n}`,
        name: `Design ${n}`,
        plantId: plant.id,
        requirements: REQ,
        inputsSnapshot: {},
        ...over,
      })
      .returning();
    let i = 0;
    for (const [key, kg] of Object.entries(lines))
      await env.db.insert(schema.mixDesignLines).values({
        tenantId: env.tenantId,
        designId: d!.id,
        materialId: mat[key]!,
        quantityKgM3: kg,
        originalQuantity: kg,
        originalUnit: 'kg/m3',
        originalName: key,
        sourceLine: ++i,
        matchMethod: 'exact',
      });
    return d!.id;
  };
  const snapshot = async (name = 'Q4', skip: string[] = []) => {
    const [s] = await env.db
      .insert(schema.priceSnapshots)
      .values({
        tenantId: env.tenantId,
        name,
        asOf: '2026-09-30',
        plantIds: [plant.id],
        lineCount: 5,
        contentHash: `h${++n}`,
      })
      .returning();
    for (const [key, t] of Object.entries(TESTS).filter(([k]) => !skip.includes(k)))
      await env.db.insert(schema.priceSnapshotLines).values({
        snapshotId: s!.id,
        materialId: mat[key]!,
        plantId: plant.id,
        supplierId,
        priceId: crypto.randomUUID(),
        status: 'ok',
        price: t.price[0],
        unit: t.price[1],
        includesDelivery: true,
        effectiveFrom: '2026-01-01',
      });
    return s!.id;
  };
  return { plantId: plant.id, mat, design, snapshot };
}

export const attestedValues = async (env: TestEnv) => ({
  status: 'in_production' as const,
  approvalSource: 'legacy_attested' as const,
  externalApprovalRef: 'Submittal 7',
  approvedBy: (await env.seedUser('qc_manager')).id,
  approvedAt: new Date('2025-03-01'),
  avgMonthlyVolumeM3: '1200.00',
});
