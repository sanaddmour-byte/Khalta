// `pnpm rules:sync` and `pnpm rules:export-seed [outdir]`: operate on DATABASE_URL, single tenant.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createDb, schema, withAudit } from '@khalta/db';
import { loadSeeds } from '@khalta/rules/loader';
import { eq } from 'drizzle-orm';
import { stringify } from 'yaml';
import { currentRules, syncRules } from './service';

const [cmd, outDir = 'rules-export'] = process.argv.slice(2);
const url = process.env['DATABASE_URL'];
if (!url) throw new Error('DATABASE_URL is required');
const handle = createDb(url);
const [tenant] = await handle.db.select().from(schema.tenants).limit(1);
if (!tenant)
  throw new Error('no tenant yet: start the API once (it creates the tenant) or run seed:dev');

if (cmd === 'sync') {
  const seeds = loadSeeds();
  if (seeds.errors.length) throw new Error(`seed files are invalid:\n${seeds.errors.join('\n')}`);
  const ctx = { tenantId: tenant.id, actor: null, requestId: 'rules-sync-cli' };
  const result = await withAudit(handle.db, ctx, (tx, audit) =>
    syncRules(tx, audit, tenant.id, seeds),
  );
  console.log(
    `inserted ${result.inserted} rule(s); ${result.drift.length} differ from the seed files (database wins)`,
  );
  for (const d of result.drift) console.log(`  drift: ${d.ruleset}:${d.key}`);
} else if (cmd === 'export') {
  // Writes the CURRENT database content as seed-shaped YAML for a reviewed commit. `verified` is always
  // written as false: verification lives in the database history, and files must never claim it.
  const rows = await currentRules(handle.db, tenant.id);
  const sets = new Map(
    (
      await handle.db.select().from(schema.rulesets).where(eq(schema.rulesets.tenantId, tenant.id))
    ).map((r) => [r.code, r]),
  );
  mkdirSync(outDir, { recursive: true });
  const byRuleset = new Map<string, typeof rows>();
  for (const r of rows) byRuleset.set(r.ruleset, [...(byRuleset.get(r.ruleset) ?? []), r]);
  for (const [code, list] of byRuleset) {
    const rs = sets.get(code);
    const doc = {
      ruleset: code,
      edition: rs?.edition ?? '',
      ...(rs?.sourceDoc ? { source_doc: rs.sourceDoc } : {}),
      rules: list.map(({ row }) => ({
        key: row.key,
        requirement: row.requirement,
        kind: row.kind,
        requirement_class: row.requirementClass,
        ...(row.grp ? { group: row.grp } : {}),
        ...(Object.keys(row.appliesTo as object).length ? { applies_to: row.appliesTo } : {}),
        ...(row.kind === 'table' ? { definition: row.definition } : { value: row.value }),
        ...(row.inherits ? { inherits: row.inherits } : {}),
        units: row.units,
        clause_ref: row.clauseRef,
        verified: false,
        ...(row.noteEn ? { note_en: row.noteEn } : {}),
        ...(row.noteAr ? { note_ar: row.noteAr } : {}),
      })),
    };
    writeFileSync(join(outDir, `${code}.yaml`), stringify(doc, { lineWidth: 0 }));
    console.log(`wrote ${join(outDir, `${code}.yaml`)} (${list.length} rules)`);
  }
} else {
  console.error('usage: rules:sync | rules:export-seed [outdir]');
  process.exitCode = 1;
}
await handle.close();
