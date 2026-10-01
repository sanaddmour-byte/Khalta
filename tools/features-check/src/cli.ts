import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { approvedFor, parseManifest } from './index';

const root = join(import.meta.dirname, '../../..');
const file = join(root, 'docs/spec/06-features.md');
const milestone = process.argv[2];

const { features, errors } = parseManifest(readFileSync(file, 'utf8'));
if (errors.length) {
  console.error(
    `docs/spec/06-features.md is invalid:\n${errors.map((e) => `  - ${e}`).join('\n')}`,
  );
  process.exit(1);
}

if (milestone) {
  const list = approvedFor(features, milestone);
  console.log(`Approved features for ${milestone}: ${list.length}`);
  for (const f of list) console.log(`  ${f.id}  [${f.priority}]  ${f.status.padEnd(8)} ${f.title}`);
} else {
  const ms = [...new Set(features.map((f) => f.milestone))].sort();
  console.log(`${features.length} features, manifest valid.`);
  for (const m of ms) {
    const a = approvedFor(features, m);
    console.log(`  ${m}: ${a.length} approved/building (${a.map((f) => f.id).join(', ') || '-'})`);
  }
}
