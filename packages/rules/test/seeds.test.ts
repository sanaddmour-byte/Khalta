import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { seedFileSchema } from '../src/schema';

const seedsDir = join(import.meta.dirname, '..', 'seeds');

function yamlFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return yamlFiles(full);
    return /\.ya?ml$/.test(name) ? [full] : [];
  });
}

describe('seed files', () => {
  const files = yamlFiles(seedsDir);

  it.each(files)('%s matches the seed schema', (file) => {
    expect(() => seedFileSchema.parse(parse(readFileSync(file, 'utf8')))).not.toThrow();
  });

  it('accepts a minimal valid seed and rejects an unknown class', () => {
    const ok = { ruleset: 'ACI', edition: 'x', rules: [] };
    expect(seedFileSchema.safeParse(ok).success).toBe(true);
    const bad = {
      ...ok,
      rules: [{ key: 'a', kind: 'value', requirement_class: 'NOPE', verified: false }],
    };
    expect(seedFileSchema.safeParse(bad).success).toBe(false);
  });
});
