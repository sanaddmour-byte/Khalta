import { tableDefinitionSchema, validateValue, type RuleKind } from '@khalta/rules';
import Papa from 'papaparse';
import { sameJson } from './canonical';

// Appendix D columns for `js-rule-values.csv`, plus the optional value_json for structured values.
export const CSV_COLUMNS = [
  'rule_key',
  'value',
  'units',
  'clause_ref',
  'requirement_class',
  'note_ar',
  'note_en',
  'value_json',
] as const;
const REQUIRED = ['rule_key', 'value', 'units', 'clause_ref', 'requirement_class'] as const;

export interface ImportRow {
  line: number;
  ruleKey: string;
  status: 'ok' | 'unchanged' | 'error';
  errors: string[];
  ruleId?: string;
  baseVersion?: number;
  current?: { value: unknown; definition: unknown; inherits: string | null; clauseRef: string };
  proposed?: {
    value?: unknown;
    definition?: unknown;
    inherits?: string | null;
    clauseRef: string;
    noteEn?: string | null;
    noteAr?: string | null;
  };
}

export interface ImportPreview {
  rows: ImportRow[];
  summary: { total: number; ok: number; unchanged: number; errors: number };
  fileErrors: string[];
}

export interface TargetRule {
  id: string;
  key: string;
  kind: string;
  requirementClass: string;
  units: string;
  version: number;
  value: unknown;
  definition: unknown;
  inherits: string | null;
  clauseRef: string;
}

const PLACEHOLDER = /(TBD|…|\.\.\.)/;
const same = sameJson;

function parseCell(
  kind: RuleKind,
  cell: string,
  json: string,
): { value?: unknown; definition?: unknown; inherits?: string; error?: string } {
  if (json.trim()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      return { error: 'value_json is not valid JSON' };
    }
    if (kind === 'table') {
      const t = tableDefinitionSchema.safeParse(parsed);
      return t.success
        ? { definition: t.data }
        : { error: `value_json is not a valid table: ${t.error.issues[0]?.message}` };
    }
    const err = validateValue(kind, parsed);
    return err ? { error: err } : { value: parsed };
  }
  const v = cell.trim();
  if (!v) return { error: 'value is empty (leave the row out to keep "not on file")' };
  if (v.startsWith('inherits:')) {
    const ref = v.slice('inherits:'.length).trim();
    return /^[A-Z0-9_]+:[A-Za-z0-9_.-]+$/.test(ref)
      ? { inherits: ref }
      : { error: 'inherits needs the form inherits:ACI:<rule_key>' };
  }
  switch (kind) {
    case 'limit_max':
    case 'limit_min':
    case 'tolerance': {
      const value = /^\d+\/\d+$/.test(v) ? v : Number(v);
      const err = validateValue(kind, value);
      return err || Number.isNaN(value) ? { error: err ?? `"${v}" is not a number` } : { value };
    }
    case 'prohibition':
      return v === 'true' || v === 'false'
        ? { value: v === 'true' }
        : { error: 'prohibition needs true or false' };
    case 'allowed_set':
      return {
        value: v
          .split(';')
          .map((x) => x.trim())
          .filter(Boolean),
      };
    default:
      return { error: `a ${kind} rule needs value_json` };
  }
}

/** Validates a js-rule-values CSV against the current JS skeleton. Nothing is written here. */
export function previewCsv(
  csv: string,
  jsRules: TargetRule[],
  refExists: (ref: string) => boolean,
): ImportPreview {
  const fileErrors: string[] = [];
  const parsed = Papa.parse<Record<string, string>>(csv.replace(/^\uFEFF/, ''), {
    header: true,
    skipEmptyLines: 'greedy',
    transformHeader: (h) => h.trim(),
  });
  const fields = parsed.meta.fields ?? [];
  for (const f of REQUIRED) if (!fields.includes(f)) fileErrors.push(`missing column "${f}"`);
  for (const f of fields)
    if (!(CSV_COLUMNS as readonly string[]).includes(f)) fileErrors.push(`unknown column "${f}"`);
  for (const e of parsed.errors)
    if (e.code !== 'TooFewFields' && e.code !== 'TooManyFields')
      fileErrors.push(`line ${e.row !== undefined ? e.row + 2 : '?'}: ${e.message}`);
  if (fileErrors.length)
    return { rows: [], summary: { total: 0, ok: 0, unchanged: 0, errors: 0 }, fileErrors };

  const byKey = new Map(jsRules.map((r) => [r.key, r]));
  const seen = new Set<string>();
  const rows: ImportRow[] = parsed.data.map((raw, i): ImportRow => {
    const line = i + 2;
    const ruleKey = (raw['rule_key'] ?? '').trim();
    const errors: string[] = [];
    const target = byKey.get(ruleKey);
    if (!ruleKey) errors.push('rule_key is empty');
    else if (!target) errors.push(`unknown rule_key "${ruleKey}" (not in the Jordanian skeleton)`);
    if (seen.has(ruleKey)) errors.push('duplicate rule_key in this file');
    seen.add(ruleKey);
    if (!target) return { line, ruleKey, status: 'error', errors };

    const units = (raw['units'] ?? '').trim();
    if (units !== target.units)
      errors.push(`units "${units}" do not match the rule's units "${target.units}"`);
    const cls = (raw['requirement_class'] ?? '').trim();
    if (cls !== target.requirementClass)
      errors.push(`requirement_class "${cls}" does not match "${target.requirementClass}"`);
    const clause = (raw['clause_ref'] ?? '').trim();
    if (!clause) errors.push('clause_ref is required');
    else if (PLACEHOLDER.test(clause)) errors.push(`clause_ref "${clause}" is still a placeholder`);
    const cell = parseCell(target.kind as RuleKind, raw['value'] ?? '', raw['value_json'] ?? '');
    if (cell.error) errors.push(cell.error);
    if (cell.inherits && !refExists(cell.inherits))
      errors.push(`inherits target ${cell.inherits} does not exist`);

    const proposed: ImportRow['proposed'] = {
      clauseRef: clause,
      ...(cell.value !== undefined ? { value: cell.value } : {}),
      ...(cell.definition !== undefined ? { definition: cell.definition } : {}),
      ...(cell.inherits !== undefined ? { inherits: cell.inherits } : {}),
      ...((raw['note_en'] ?? '').trim() ? { noteEn: raw['note_en']!.trim() } : {}),
      ...((raw['note_ar'] ?? '').trim() ? { noteAr: raw['note_ar']!.trim() } : {}),
    };
    const current = {
      value: target.value,
      definition: target.definition,
      inherits: target.inherits,
      clauseRef: target.clauseRef,
    };
    if (errors.length)
      return {
        line,
        ruleKey,
        status: 'error',
        errors,
        ruleId: target.id,
        baseVersion: target.version,
        current,
      };
    const unchanged =
      same(proposed.value ?? null, target.value) &&
      same(proposed.definition ?? null, target.definition) &&
      same(proposed.inherits ?? null, target.inherits) &&
      proposed.clauseRef === target.clauseRef;
    return {
      line,
      ruleKey,
      status: unchanged ? 'unchanged' : 'ok',
      errors: [],
      ruleId: target.id,
      baseVersion: target.version,
      current,
      proposed,
    };
  });

  const summary = {
    total: rows.length,
    ok: rows.filter((r) => r.status === 'ok').length,
    unchanged: rows.filter((r) => r.status === 'unchanged').length,
    errors: rows.filter((r) => r.status === 'error').length,
  };
  if (rows.length === 0) fileErrors.push('the file has no data rows');
  return { rows, summary, fileErrors };
}
