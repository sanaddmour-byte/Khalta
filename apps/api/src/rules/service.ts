import { schema, type Executor, type Tx, type AuditRecorder } from '@khalta/db';
import type { RuleRecord, RuleSeed } from '@khalta/rules';
import { and, eq } from 'drizzle-orm';
import { conflict, notFound } from '../errors';
import { sameJson } from './canonical';

type RuleRow = typeof schema.rules.$inferSelect;

export interface RuleDto {
  id: string;
  ruleset: string;
  key: string;
  requirement: string;
  kind: string;
  requirementClass: string;
  group: string | null;
  appliesTo: unknown;
  prerequisites: unknown;
  value: unknown;
  definition: unknown;
  inherits: string | null;
  units: string;
  clauseRef: string;
  noteEn: string | null;
  noteAr: string | null;
  verified: boolean;
  verifiedBy: string | null;
  verifiedAt: Date | null;
  version: number;
  origin: string;
  createdBy: string | null;
  changeReason: string | null;
  /** verified | unverified | missing (no value on file; informational rows are never "missing") */
  status: 'verified' | 'unverified' | 'missing' | 'info';
  /** Designs depending on this rule. Designs arrive in M2.2+, so this is 0 for now. */
  usedByDesigns: number;
}

const hasValue = (r: Pick<RuleRow, 'value' | 'definition' | 'inherits'>) =>
  r.value !== null || r.definition !== null || r.inherits !== null;

export function toDto(r: RuleRow, ruleset: string): RuleDto {
  const status: RuleDto['status'] =
    r.kind === 'info' && !hasValue(r)
      ? 'info'
      : !hasValue(r)
        ? 'missing'
        : r.verified
          ? 'verified'
          : 'unverified';
  return {
    id: r.id,
    ruleset,
    key: r.key,
    requirement: r.requirement,
    kind: r.kind,
    requirementClass: r.requirementClass,
    group: r.grp,
    appliesTo: r.appliesTo,
    prerequisites: r.prerequisites,
    value: r.value,
    definition: r.definition,
    inherits: r.inherits,
    units: r.units,
    clauseRef: r.clauseRef,
    noteEn: r.noteEn,
    noteAr: r.noteAr,
    verified: r.verified,
    verifiedBy: r.verifiedBy,
    verifiedAt: r.verifiedAt,
    version: r.version,
    origin: r.origin,
    createdBy: r.createdBy,
    changeReason: r.changeReason,
    status,
    usedByDesigns: 0,
  };
}

export function toRecord(r: RuleRow, ruleset: string): RuleRecord {
  return {
    id: r.id,
    ruleset,
    version: r.version,
    key: r.key,
    requirement: r.requirement,
    kind: r.kind as RuleRecord['kind'],
    requirement_class: r.requirementClass as RuleRecord['requirement_class'],
    group: r.grp ?? undefined,
    applies_to: r.appliesTo as Record<string, unknown>,
    prerequisites: r.prerequisites as string[],
    value: r.value ?? null,
    definition: (r.definition ?? null) as RuleRecord['definition'],
    inherits: r.inherits ?? undefined,
    units: r.units as RuleRecord['units'],
    clause_ref: r.clauseRef,
    note_en: r.noteEn ?? undefined,
    note_ar: r.noteAr ?? undefined,
    verified: r.verified,
  };
}

export async function currentRules(
  db: Executor,
  tenantId: string,
): Promise<{ row: RuleRow; ruleset: string }[]> {
  const rows = await db
    .select({ row: schema.rules, ruleset: schema.rulesets.code })
    .from(schema.rules)
    .innerJoin(schema.rulesets, eq(schema.rulesets.id, schema.rules.rulesetId))
    .where(and(eq(schema.rules.tenantId, tenantId), eq(schema.rules.isCurrent, true)));
  return rows.sort(
    (a, b) => a.ruleset.localeCompare(b.ruleset) || a.row.key.localeCompare(b.row.key),
  );
}

export async function loadCurrentRecords(db: Executor, tenantId: string): Promise<RuleRecord[]> {
  return (await currentRules(db, tenantId)).map(({ row, ruleset }) => toRecord(row, ruleset));
}

const seedToValues = (s: RuleSeed) => ({
  requirement: s.requirement ?? s.key,
  kind: s.kind,
  requirementClass: s.requirement_class,
  grp: s.group ?? null,
  appliesTo: s.applies_to,
  prerequisites: s.prerequisites,
  value: s.value ?? null,
  definition: s.definition ?? null,
  inherits: s.inherits ?? null,
  units: s.units,
  clauseRef: s.clause_ref,
  sourceDoc: s.source_doc ?? null,
  validFrom: s.valid_from ?? null,
  validTo: s.valid_to ?? null,
  noteEn: s.note_en ?? null,
  noteAr: s.note_ar ?? null,
});

export interface SyncResult {
  inserted: number;
  /** Keys whose database content differs from the seed file (the database wins; QC edits are never overwritten). */
  drift: { ruleset: string; key: string }[];
}

/**
 * Idempotent bootstrap from seed files. Inserts rules that do not exist yet (unverified, version 1);
 * never overwrites existing rows. Divergence between seeds and the database is reported, not "fixed".
 */
export async function syncRules(
  tx: Tx,
  audit: AuditRecorder,
  tenantId: string,
  seeds: {
    rules: RuleRecord[];
    rulesets: { code: string; edition: string; source_doc?: string }[];
  },
): Promise<SyncResult> {
  const existingSets = await tx
    .select()
    .from(schema.rulesets)
    .where(eq(schema.rulesets.tenantId, tenantId));
  const setId = new Map(existingSets.map((s) => [s.code, s.id]));
  for (const rs of seeds.rulesets) {
    if (setId.has(rs.code)) continue;
    const [row] = await tx
      .insert(schema.rulesets)
      .values({ tenantId, code: rs.code, edition: rs.edition, sourceDoc: rs.source_doc ?? null })
      .returning();
    setId.set(rs.code, row!.id);
  }
  const current = await currentRules(tx, tenantId);
  const have = new Map(current.map((c) => [`${c.ruleset}:${c.row.key}`, c.row]));
  const insertedBy = new Map<string, number>();
  const drift: SyncResult['drift'] = [];

  for (const rule of seeds.rules) {
    const id = `${rule.ruleset}:${rule.key}`;
    const existing = have.get(id);
    const values = seedToValues(rule);
    if (existing) {
      const same =
        existing.kind === values.kind &&
        existing.requirementClass === values.requirementClass &&
        existing.units === values.units &&
        existing.clauseRef === values.clauseRef &&
        existing.requirement === values.requirement &&
        sameJson(existing.value, values.value) &&
        sameJson(existing.definition, values.definition) &&
        sameJson(existing.appliesTo, values.appliesTo);
      if (!same) drift.push({ ruleset: rule.ruleset, key: rule.key });
      continue;
    }
    await tx.insert(schema.rules).values({
      tenantId,
      rulesetId: setId.get(rule.ruleset)!,
      key: rule.key,
      version: 1,
      isCurrent: true,
      verified: false,
      origin: 'seed',
      createdBy: null,
      ...values,
    });
    insertedBy.set(rule.ruleset, (insertedBy.get(rule.ruleset) ?? 0) + 1);
  }
  for (const [code, n] of insertedBy)
    await audit.record({
      action: 'rules.seed_sync',
      entityType: 'ruleset',
      entityId: code,
      after: { inserted: n },
    });
  const inserted = [...insertedBy.values()].reduce((a, b) => a + b, 0);
  if (inserted === 0)
    await audit.record({
      action: 'rules.seed_sync',
      entityType: 'ruleset',
      entityId: 'all',
      after: { inserted: 0, drift: drift.length },
    });
  return { inserted, drift };
}

export async function getCurrentById(
  tx: Executor,
  tenantId: string,
  id: string,
): Promise<{ row: RuleRow; ruleset: string }> {
  const [r] = await tx
    .select({ row: schema.rules, ruleset: schema.rulesets.code })
    .from(schema.rules)
    .innerJoin(schema.rulesets, eq(schema.rulesets.id, schema.rules.rulesetId))
    .where(and(eq(schema.rules.id, id), eq(schema.rules.tenantId, tenantId)));
  if (!r) throw notFound('Rule not found');
  return r;
}

export interface Change {
  value?: unknown;
  definition?: unknown;
  inherits?: string | null;
  clauseRef?: string;
  noteEn?: string | null;
  noteAr?: string | null;
}

/** Edits never mutate content: they supersede the current version with a new, UNVERIFIED one. */
export async function supersede(
  tx: Tx,
  tenantId: string,
  actorId: string,
  current: RuleRow,
  change: Change,
  origin: 'ui' | 'csv',
  reason: string,
): Promise<RuleRow> {
  const locked = await tx
    .select()
    .from(schema.rules)
    .where(eq(schema.rules.id, current.id))
    .for('update');
  if (!locked[0]?.isCurrent)
    throw conflict('This rule was changed by someone else; reload and try again');
  const now = new Date();
  await tx
    .update(schema.rules)
    .set({ isCurrent: false, supersededAt: now })
    .where(eq(schema.rules.id, current.id));
  const {
    id: _id,
    createdAt: _c,
    verified: _v,
    verifiedBy: _vb,
    verifiedAt: _va,
    supersededAt: _s,
    ...keep
  } = current;
  const [next] = await tx
    .insert(schema.rules)
    .values({
      ...keep,
      tenantId,
      version: current.version + 1,
      isCurrent: true,
      verified: false,
      verifiedBy: null,
      verifiedAt: null,
      origin,
      createdBy: actorId,
      changeReason: reason,
      ...(change.value !== undefined ? { value: change.value } : {}),
      ...(change.definition !== undefined ? { definition: change.definition } : {}),
      ...(change.inherits !== undefined ? { inherits: change.inherits } : {}),
      ...(change.clauseRef !== undefined ? { clauseRef: change.clauseRef } : {}),
      ...(change.noteEn !== undefined ? { noteEn: change.noteEn } : {}),
      ...(change.noteAr !== undefined ? { noteAr: change.noteAr } : {}),
    })
    .returning();
  return next!;
}
export type { RuleRow };
