import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { evaluate } from '../src/evaluate';
import {
  fixtureSchema,
  fixtureToSnapshot,
  fixturesDir,
  loadFixtures,
} from '../src/testing/fixtures';

const fixtures = loadFixtures();

describe('evaluate fixtures (SYNTHETIC, hand-computed)', () => {
  it('there are at least four, every one labelled synthetic', () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(4);
    for (const f of fixtures) {
      expect(f.synthetic).toBe(true);
      expect(f.source).toMatch(/SYNTHETIC/);
    }
  });

  it.each(fixtures.map((f) => [f.id, f] as const))(
    '%s reproduces the expected numbers',
    (_id, f) => {
      const r = evaluate(fixtureToSnapshot(f));
      const tol = f.expected.tolerance;
      expect(
        Math.abs((r.figures['volume.total'] as number) - f.expected.volume_m3),
      ).toBeLessThanOrEqual(tol.volume);
      if (f.expected.wcm !== null)
        expect(Math.abs((r.figures['ratio.wcm'] as number) - f.expected.wcm)).toBeLessThanOrEqual(
          tol.wcm,
        );
      if (f.expected.cost_jod_per_m3 === null) {
        expect(r.cost.state).toBe('incomplete');
        expect(r.cost.totalJodPerM3).toBeNull();
      } else {
        expect(
          Math.abs(Number(r.cost.totalJodPerM3) - Number(f.expected.cost_jod_per_m3)),
        ).toBeLessThanOrEqual(tol.cost);
      }
      for (const [id, status] of Object.entries(f.expected.compliance))
        expect(r.checks.find((c) => c.id === id)?.status, `${f.id}: ${id}`).toBe(status);
      expect(r.verdict).toBe(f.expected.verdict);
      if (f.expected.fcr_mpa !== null) expect(r.strength.fcrMpa).toBeCloseTo(f.expected.fcr_mpa, 6);
    },
  );

  it('fixture.schema.json is in sync with the fixture schema', () => {
    const file = join(fixturesDir, 'fixture.schema.json');
    const current = z.toJSONSchema(fixtureSchema);
    // regenerate with UPDATE_FIXTURE_SCHEMA=1 pnpm --filter @khalta/engine test, then run prettier
    if (process.env['UPDATE_FIXTURE_SCHEMA'])
      writeFileSync(file, JSON.stringify(current, null, 2) + '\n');
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(JSON.parse(JSON.stringify(current)));
  });
});
