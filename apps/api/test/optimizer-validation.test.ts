// The optimizer and the independent validator together (neither may import the other, so this is where they
// meet). SYNTHETIC world from @khalta/engine/testing/optimizer.
import {
  candidateRecord,
  createHighsSolver,
  optimize,
  type OptimizeResult,
  type Solver,
} from '@khalta/engine/optimizer';
import { optimizerInput } from '@khalta/engine/testing/optimizer';
import type { ResolvedCharacteristic } from '@khalta/engine';
import { validateCandidate } from '@khalta/validator';
import { beforeAll, describe, expect, it } from 'vitest';

let solver: Solver;
beforeAll(async () => {
  solver = await createHighsSolver();
}, 30_000);

const ch = (key: string, spec: Record<string, unknown>, sub: string | null = null) =>
  ({ key, sub, spec, origin: 'request' }) as ResolvedCharacteristic;

const SCENARIOS: [string, Parameters<typeof optimizerInput>[0]][] = [
  ['plain C30', {}],
  ['C25, slump 160', { request: { fcMpa: 25, slumpMm: 160 } }],
  ['C20, slump 60, pumpable', { request: { fcMpa: 20, slumpMm: 60, pumpable: true } }],
  ['sulfate S1 (cement chosen by C3A)', { request: { exposure: ['F0', 'S1', 'W0', 'C1'] } }],
  [
    'both codes, stricter JS w/cm',
    {
      mode: 'BOTH',
      mirrorJs: true,
      request: { exposure: ['F0', 'S1', 'W0', 'C1'] },
      extraRules: { 'JS:durability.S1.max_wcm': 0.4 },
    },
  ],
  [
    'fixed w/cm above the baseline',
    { characteristics: [ch('wcm', { mode: 'fixed', value: 0.5 })] },
  ],
  [
    'fixed free water below the model estimate',
    { characteristics: [ch('water_kg', { mode: 'fixed', value: 185 })] },
  ],
  [
    'targets, closest first',
    {
      objective: 'closest_to_targets',
      characteristics: [
        ch('binder_kg', { mode: 'target', value: 400 }),
        ch('paste_l', { mode: 'target', value: 330 }),
      ],
    },
  ],
  [
    'grading characteristics',
    {
      characteristics: [
        ch('shilstone.cf', { mode: 'range', min: 56, max: 62 }),
        ch('passing_pct', { mode: 'range', min: 38, max: 45 }, '2.36'),
        ch('fm_combined', { mode: 'range', min: 4.6, max: 5.3 }),
      ],
    },
  ],
  [
    'fixed SCM and admixture',
    {
      characteristics: [
        ch('scm', { mode: 'fixed', product: 'fly', pct: 20 }),
        ch('admixture', { mode: 'fixed', product: 'sp', dosage_level: 1 }),
      ],
    },
  ],
  ['excluded materials', { include: { exclude: ['crusher', 'cem-sr'] } }],
  ['maximum cost', { characteristics: [ch('max_cost_jod_m3', { mode: 'range', max: 55 })] }],
];

describe('every candidate the optimizer returns passes the independent validator', () => {
  for (const [name, over] of SCENARIOS as [string, NonNullable<(typeof SCENARIOS)[number][1]>][])
    it(name, async () => {
      const r: OptimizeResult = await optimize(optimizerInput(over), {
        solver,
        validate: (rec) => validateCandidate(rec).status === 'pass',
      });
      expect(['candidates', 'infeasible', 'no_valid_candidate']).toContain(r.status);
      expect(r.status, JSON.stringify(r.notes)).toBe('candidates');
      for (const c of r.candidates) {
        const v = validateCandidate(candidateRecord(c, over.include ?? {}));
        expect(v.mismatches).toEqual([]);
        expect(v.evaluation.status).toBe('pass');
      }
    });

  it('and the validator refuses the same candidate once it is tampered with', async () => {
    const r = await optimize(optimizerInput({ settings: { candidatesTopN: 1 } }), { solver });
    const rec = candidateRecord(r.candidates[0]!, {});
    expect(validateCandidate(rec).status).toBe('pass');
    const bent = JSON.parse(JSON.stringify(rec)) as typeof rec;
    bent.snapshot.lines[0]!.kgPerM3 = (Number(bent.snapshot.lines[0]!.kgPerM3) - 20).toFixed(3);
    expect(validateCandidate(bent).status).toBe('fail');
    const lies = JSON.parse(JSON.stringify(rec)) as typeof rec;
    lies.guardrails.finesPct = 0;
    expect(validateCandidate(lies).status).toBe('fail');
  });
});
