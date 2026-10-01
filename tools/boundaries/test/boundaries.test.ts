import { createRequire } from 'node:module';
import { join } from 'node:path';
import { cruise } from 'dependency-cruiser';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const config = require('../dependency-cruiser.cjs');
const fixtures = join(import.meta.dirname, '..', 'fixtures');

async function violations(name: string) {
  // fixtures are excluded from the real run; the test overrides that exclusion
  const result = await cruise([join(fixtures, name, 'packages')], {
    ...config.options,
    exclude: undefined,
    validate: true,
    ruleSet: { forbidden: config.forbidden },
    tsConfig: undefined,
    tsPreCompilationDeps: true,
  });
  if (typeof result.output === 'string') throw new Error('unexpected output');
  return result.output.summary.violations;
}

describe('validator-must-not-reach-optimizer', () => {
  it('flags a barrel re-export that reaches the optimizer', async () => {
    const v = await violations('bad');
    expect(v.length).toBeGreaterThan(0);
    expect(v[0]?.rule.name).toBe('validator-must-not-reach-optimizer');
  });

  it('passes when the validator only uses non-optimizer engine code', async () => {
    expect(await violations('good')).toEqual([]);
  });
});
