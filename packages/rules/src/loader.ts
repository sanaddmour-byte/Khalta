// File-system loader for the YAML seeds. Kept out of the package root so browser code never imports `node:fs`.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parse } from 'yaml';
import { seedFileSchema, toRecord, type RuleRecord } from './schema';

export interface SeedLoadResult {
  rules: RuleRecord[];
  /** Per-file edition/source info so callers can create rulesets. */
  rulesets: { code: string; edition: string; source_doc?: string }[];
  errors: string[];
}

export const defaultSeedsDir = join(import.meta.dirname, '..', 'seeds');

function yamlFiles(dir: string): string[] {
  return readdirSync(dir)
    .sort()
    .flatMap((name) => {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) return yamlFiles(full);
      return /\.ya?ml$/.test(name) ? [full] : [];
    });
}

export function loadSeeds(dir = defaultSeedsDir): SeedLoadResult {
  const rules: RuleRecord[] = [];
  const rulesets = new Map<string, { code: string; edition: string; source_doc?: string }>();
  const errors: string[] = [];
  const seen = new Map<string, string>();

  for (const file of yamlFiles(dir)) {
    const rel = relative(dir, file);
    let raw: unknown;
    try {
      raw = parse(readFileSync(file, 'utf8'));
    } catch (e) {
      errors.push(`${rel}: not valid YAML (${(e as Error).message})`);
      continue;
    }
    const parsed = seedFileSchema.safeParse(raw);
    if (!parsed.success) {
      for (const i of parsed.error.issues)
        errors.push(`${rel}: ${i.path.join('.') || '(file)'}: ${i.message}`);
      continue;
    }
    const f = parsed.data;
    if (!rulesets.has(f.ruleset))
      rulesets.set(f.ruleset, {
        code: f.ruleset,
        edition: f.edition,
        ...(f.source_doc ? { source_doc: f.source_doc } : {}),
      });
    for (const r of f.rules) {
      const id = `${f.ruleset}:${r.key}`;
      if (seen.has(id)) errors.push(`${rel}: duplicate rule ${id} (first in ${seen.get(id)})`);
      seen.set(id, rel);
      rules.push(toRecord(r, f.ruleset));
    }
  }

  // `inherits` must point at an existing rule.
  const ids = new Set(rules.map((r) => r.id));
  for (const r of rules)
    if (r.inherits && !ids.has(r.inherits))
      errors.push(`${r.id}: inherits unknown rule ${r.inherits}`);
  return { rules, rulesets: [...rulesets.values()], errors };
}
