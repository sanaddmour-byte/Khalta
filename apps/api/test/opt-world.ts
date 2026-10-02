// SYNTHETIC optimizer world shared by API tests: plants with the engine's synthetic materials and the
// synthetic engineering parameters written into the rules.
import { schema } from '@khalta/db';
import { OPT_MATERIALS, syntheticRules } from '@khalta/engine/testing/optimizer';
import { loadSeeds } from '@khalta/rules/loader';
import { syncRules } from '../src/rules/service';
import type { TestEnv } from './helpers';
import { makeSupplier } from './world';

export const REQUIREMENTS = {
  fcMpa: 30,
  basis: 'cylinder',
  exposure: ['F0', 'S0', 'W0', 'C1'],
  slumpMm: 100,
  nmasMm: 19,
};

export async function seedMaterials(env: TestEnv, plantId: string, supplierId: string) {
  const ids: Record<string, string> = {};
  for (const m of OPT_MATERIALS) {
    const [row] = await env.db
      .insert(schema.materials)
      .values({
        tenantId: env.tenantId,
        plantId,
        category: m.category,
        marketNameEn: `${m.id} ${plantId.slice(0, 4)}`,
        marketNameAr: `${m.id} ${plantId.slice(0, 4)}`,
      })
      .returning();
    ids[m.id] = row!.id;
    await env.db.insert(schema.materialTests).values({
      tenantId: env.tenantId,
      materialId: row!.id,
      version: 1,
      isCurrent: true,
      source: 'supplier_datasheet',
      properties: m.test!.properties,
      testedAt: '2026-08-01',
    });
    const p = m.price as { price: string; unit: 'JOD/ton' | 'JOD/kg' };
    await env.db.insert(schema.materialPrices).values({
      tenantId: env.tenantId,
      materialId: row!.id,
      plantId,
      supplierId,
      price: p.price,
      unit: p.unit,
      effectiveFrom: '2026-01-01',
    });
  }
  return ids;
}

export async function syntheticRulesInto(env: TestEnv) {
  const seeds = loadSeeds();
  await env.withAudit(env.db, { tenantId: env.tenantId, actor: null, requestId: 'seed' }, (tx, a) =>
    syncRules(tx, a, env.tenantId, { ...seeds, rules: syntheticRules(seeds.rules) }),
  );
}

export async function optimizerWorld(env: TestEnv, codes: string[]) {
  await syntheticRulesInto(env);
  const supplierId = await makeSupplier(env);
  const plants: string[] = [];
  const mats: Record<string, string>[] = [];
  for (const c of codes) {
    const p = await env.seedPlant(c);
    plants.push(p.id);
    mats.push(await seedMaterials(env, p.id, supplierId));
  }
  return { plants, mats };
}
