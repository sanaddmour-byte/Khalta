// Evaluate-fixture format (05-appendices App. B): given proportions and the numbers a person expects.
// Fixtures are labelled SYNTHETIC unless they come from a real approved design.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { Category } from '../materials/properties';
import type { EvaluationSnapshot, SnapshotMaterial } from '../evaluate/types';
import { makeSnapshot } from './synthetic';
import { selectRules } from '../evaluate/select';
import { ALL_RULES } from './synthetic';

const material = z.looseObject({
  id: z.string().min(1),
  category: z.enum([
    'cement',
    'scm',
    'fine_agg',
    'coarse_agg',
    'water',
    'admixture',
    'fiber',
    'pigment',
  ]),
  passing_pct: z.record(z.string(), z.number()).optional(),
  price_jod_per_kg: z.number().nonnegative().optional(),
});

export const fixtureSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9-]+$/),
  mode: z.literal('evaluate'),
  source: z.string().min(1),
  synthetic: z.boolean(),
  ruleset_mode: z.enum(['ACI', 'JS', 'BOTH']),
  request: z.strictObject({
    fc_mpa: z.number().positive(),
    basis: z.enum(['cylinder', 'cube', 'b_grade']),
    exposure: z.array(z.string()),
    slump_mm: z.number().nullable().optional(),
    nmas_mm: z.number().nullable().optional(),
    pumpable: z.boolean().nullable().optional(),
    air_pct: z.number().nullable().optional(),
    s3_option: z
      .union([z.literal(1), z.literal(2)])
      .nullable()
      .optional(),
  }),
  project_overrides: z
    .array(
      z.strictObject({
        requirement: z.string(),
        value: z.unknown(),
        kind: z.string().optional(),
        units: z.string().optional(),
        clause_ref: z.string().optional(),
      }),
    )
    .optional(),
  materials: z.array(material).min(1),
  proportions_kg_per_m3: z.record(z.string(), z.number().positive()),
  expected: z.strictObject({
    wcm: z.number().nullable(),
    volume_m3: z.number(),
    /** Decimal string in JOD/m³, or null when the cost is expected to be incomplete. */
    cost_jod_per_m3: z.string().nullable(),
    compliance: z.record(z.string(), z.enum(['pass', 'fail', 'not_evaluated'])),
    verdict: z.enum(['pass', 'fail', 'incomplete']),
    fcr_mpa: z.number().nullable(),
    tolerance: z.strictObject({ volume: z.number(), wcm: z.number(), cost: z.number() }),
  }),
});
export type Fixture = z.output<typeof fixtureSchema>;

export const fixturesDir = join(import.meta.dirname, '..', '..', 'test', 'fixtures');

export function loadFixtures(dir = fixturesDir): Fixture[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json') && f !== 'fixture.schema.json')
    .sort()
    .map((f) => fixtureSchema.parse(JSON.parse(readFileSync(join(dir, f), 'utf8'))));
}

const NON_PROPERTY = new Set(['id', 'category', 'passing_pct', 'price_jod_per_kg']);

export function fixtureToSnapshot(f: Fixture): EvaluationSnapshot {
  const mats: SnapshotMaterial[] = f.materials.map((m) => {
    const properties: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(m)) if (!NON_PROPERTY.has(k)) properties[k] = v;
    if (m.passing_pct)
      properties['sieve_analysis'] = Object.entries(m.passing_pct).map(([s, p]) => ({
        sieve_mm: Number(s),
        passing_pct: p,
      }));
    return {
      id: m.id,
      category: m.category as Category,
      nameEn: m.id,
      nameAr: null,
      test: {
        id: `t-${m.id}`,
        version: 1,
        source: 'lab_report',
        fieldSources: {},
        testedAt: '2026-08-01',
        validUntil: null,
        freshness: 'fresh',
        properties,
      },
      price:
        m.price_jod_per_kg === undefined
          ? { status: 'unavailable' }
          : {
              status: 'ok',
              priceId: `p-${m.id}`,
              // per tonne so the figure fits the 3-decimal price format used by the database
              price: String(Math.round(m.price_jod_per_kg * 1e6) / 1e3),
              unit: 'JOD/ton',
              supplierId: 's',
              includesDelivery: true,
              effectiveFrom: '2026-09-01',
              staleness: 'fresh',
              ageDays: 31,
            },
    };
  });
  const request = {
    fcMpa: f.request.fc_mpa,
    basis: f.request.basis,
    testAgeDays: 28,
    exposure: f.request.exposure,
    s3Option: f.request.s3_option ?? null,
    slumpMm: f.request.slump_mm ?? null,
    nmasMm: f.request.nmas_mm ?? null,
    pumpable: f.request.pumpable ?? null,
    airPct: f.request.air_pct ?? null,
  };
  const base = makeSnapshot({
    mode: f.ruleset_mode,
    request,
    materials: mats,
    lines: Object.entries(f.proportions_kg_per_m3).map(([materialId, kg]) => ({
      materialId,
      kgPerM3: kg.toFixed(3),
    })),
    projectOverrides: (f.project_overrides ?? []) as EvaluationSnapshot['projectOverrides'],
    rules: selectRules(ALL_RULES, f.ruleset_mode, request),
  });
  return base;
}
