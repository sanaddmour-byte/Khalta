import { schema } from '@khalta/db';
import {
  approvalBlockers,
  resolve,
  tableDefinitionSchema,
  validateValue,
  type RuleKind,
} from '@khalta/rules';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { conflict, forbidden, notFound } from '../errors';
import type { ApiRoutes } from '../route';
import { sameJson } from '../rules/canonical';
import { previewCsv } from '../rules/csv';
import {
  currentRules,
  getCurrentById,
  loadCurrentRecords,
  supersede,
  toDto,
  type Change,
} from '../rules/service';

const idParam = z.object({ id: z.uuid() });
const list = z.object({
  ruleset: z.string().max(40).optional(),
  requirementClass: z.string().max(40).optional(),
  status: z.enum(['verified', 'unverified', 'missing', 'info']).optional(),
  q: z.string().max(100).optional(),
});
const verifyBody = z.strictObject({ note: z.string().trim().min(5).max(500) });
const editBody = z
  .strictObject({
    value: z
      .unknown()
      .refine((v) => v !== null, {
        message: 'a value cannot be cleared; correct it to another value',
      })
      .optional(),
    definition: tableDefinitionSchema.optional(),
    clause_ref: z.string().trim().min(1).max(300).optional(),
    reason: z.string().trim().min(5).max(500),
  })
  .refine(
    (b) => b.value !== undefined || b.definition !== undefined || b.clause_ref !== undefined,
    { message: 'nothing to change' },
  );
const importBody = z.strictObject({
  csv: z.string().min(1).max(1_000_000),
  filename: z.string().max(200).optional(),
});
const commitBody = z.strictObject({ batchId: z.uuid() });
const resolveBody = z.strictObject({
  mode: z.enum(['ACI', 'JS', 'BOTH']),
  context: z.record(z.string(), z.unknown()).default({}),
  project_overrides: z
    .array(
      z.strictObject({
        requirement: z.string().min(1),
        value: z.unknown(),
        kind: z.string().optional(),
        units: z.string().optional(),
        clause_ref: z.string().optional(),
      }),
    )
    .default([]),
  table_policy: z.record(z.string(), z.enum(['ACI', 'JS'])).default({}),
});

export function ruleRoutes(api: ApiRoutes) {
  api.get(
    '/api/rules',
    { summary: 'List current rules', capability: 'rules.read', query: list },
    async ({ auth, query, db }) => {
      const all = (await currentRules(db, auth.tenantId)).map(({ row, ruleset }) =>
        toDto(row, ruleset),
      );
      const q = query.q?.toLowerCase();
      const rules = all.filter(
        (r) =>
          (!query.ruleset || r.ruleset === query.ruleset) &&
          (!query.requirementClass || r.requirementClass === query.requirementClass) &&
          (!query.status || r.status === query.status) &&
          (!q ||
            [r.key, r.clauseRef, r.noteEn ?? '', r.noteAr ?? ''].some((s) =>
              s.toLowerCase().includes(q),
            )),
      );
      const byRuleset: Record<
        string,
        { total: number; verified: number; unverified: number; missing: number }
      > = {};
      for (const r of all) {
        const s = (byRuleset[r.ruleset] ??= { total: 0, verified: 0, unverified: 0, missing: 0 });
        if (r.status === 'info') continue;
        s.total += 1;
        if (r.status === 'verified') s.verified += 1;
        else if (r.status === 'unverified') s.unverified += 1;
        else s.missing += 1;
      }
      return { rules, summary: { byRuleset } };
    },
  );

  api.get(
    '/api/rules/:id',
    {
      summary: 'One rule with its version and verification history',
      capability: 'rules.read',
      params: idParam,
    },
    async ({ auth, params, db }) => {
      const { row, ruleset } = await getCurrentById(db, auth.tenantId, params.id);
      const versions = await db
        .select()
        .from(schema.rules)
        .where(
          and(
            eq(schema.rules.tenantId, auth.tenantId),
            eq(schema.rules.rulesetId, row.rulesetId),
            eq(schema.rules.key, row.key),
          ),
        )
        .orderBy(desc(schema.rules.version));
      const ids = versions.map((v) => v.id);
      const verifications = await db
        .select({
          id: schema.ruleVerifications.id,
          ruleId: schema.ruleVerifications.ruleId,
          note: schema.ruleVerifications.note,
          at: schema.ruleVerifications.at,
          by: schema.users.name,
        })
        .from(schema.ruleVerifications)
        .innerJoin(schema.users, eq(schema.users.id, schema.ruleVerifications.verifiedBy))
        .where(inArray(schema.ruleVerifications.ruleId, ids))
        .orderBy(desc(schema.ruleVerifications.at));
      const authors = await db
        .select({ id: schema.users.id, name: schema.users.name })
        .from(schema.users)
        .where(eq(schema.users.tenantId, auth.tenantId));
      const name = (id: string | null) =>
        id ? (authors.find((a) => a.id === id)?.name ?? null) : null;
      return {
        rule: toDto(row, ruleset),
        versions: versions.map((v) => ({
          id: v.id,
          version: v.version,
          isCurrent: v.isCurrent,
          origin: v.origin,
          createdAt: v.createdAt,
          createdByName: name(v.createdBy),
          changeReason: v.changeReason,
          verified: v.verified,
          value: v.value,
          definition: v.definition,
          clauseRef: v.clauseRef,
        })),
        verifications,
      };
    },
  );

  api.mutate(
    'post',
    '/api/rules/:id/verify',
    {
      summary: 'Verify a rule value against the licensed document (typed e-signature note)',
      capability: 'rules.verify',
      after: ({ auth }) =>
        api.jobs.enqueue(
          'rule-change',
          { tenantId: auth.tenantId },
          { singletonKey: `rules:${auth.tenantId}`, delaySeconds: api.jobDelaySeconds * 6 },
        ),
      body: verifyBody,
      params: idParam,
    },
    async ({ auth, body, params, tx, audit }) => {
      const { row, ruleset } = await getCurrentById(tx, auth.tenantId, params.id);
      const [locked] = await tx
        .select()
        .from(schema.rules)
        .where(eq(schema.rules.id, row.id))
        .for('update');
      if (!locked?.isCurrent)
        throw conflict('This rule was changed by someone else; reload and try again');
      if (locked.verified) throw conflict('This version is already verified');
      if (locked.value === null && locked.definition === null && locked.inherits === null)
        throw conflict('There is no value on file to verify');
      // Four-eyes: whoever last changed the value cannot sign it off. Seeds are system-authored.
      if (locked.createdBy && locked.createdBy === auth.user.id)
        throw forbidden('You changed this value, so someone else must verify it (four-eyes)');
      const now = new Date();
      await tx.insert(schema.ruleVerifications).values({
        tenantId: auth.tenantId,
        ruleId: locked.id,
        verifiedBy: auth.user.id,
        note: body.note,
      });
      await tx
        .update(schema.rules)
        .set({ verified: true, verifiedBy: auth.user.id, verifiedAt: now })
        .where(eq(schema.rules.id, locked.id));
      await audit.record({
        action: 'rule.verify',
        entityType: 'rule',
        entityId: locked.id,
        before: { key: locked.key, ruleset, version: locked.version, verified: false },
        after: {
          key: locked.key,
          ruleset,
          version: locked.version,
          verified: true,
          note: body.note,
        },
      });
      return { id: locked.id, verified: true };
    },
  );

  api.mutate(
    'patch',
    '/api/rules/:id/value',
    {
      summary: 'Correct a rule value (creates a new, unverified version)',
      capability: 'rules.edit',
      after: ({ auth }) =>
        api.jobs.enqueue(
          'rule-change',
          { tenantId: auth.tenantId },
          { singletonKey: `rules:${auth.tenantId}`, delaySeconds: api.jobDelaySeconds * 6 },
        ),
      body: editBody,
      params: idParam,
    },
    async ({ auth, body, params, tx, audit }) => {
      const { row, ruleset } = await getCurrentById(tx, auth.tenantId, params.id);
      const change: Change = {};
      if (row.kind === 'table') {
        if (body.value !== undefined) throw conflict('Table rules take `definition`, not `value`');
        if (body.definition !== undefined) change.definition = body.definition;
      } else {
        if (body.definition !== undefined) throw conflict('Only table rules take `definition`');
        if (body.value !== undefined) {
          const err = validateValue(row.kind as RuleKind, body.value);
          if (err) throw Object.assign(conflict(err), { status: 422, code: 'invalid_value' });
          change.value = body.value;
          change.inherits = null;
        }
      }
      if (body.clause_ref !== undefined) change.clauseRef = body.clause_ref;
      const unchanged =
        (change.value === undefined || sameJson(change.value, row.value)) &&
        (change.definition === undefined || sameJson(change.definition, row.definition)) &&
        (change.clauseRef === undefined || change.clauseRef === row.clauseRef);
      if (unchanged) throw conflict('That is already the current value');
      const next = await supersede(tx, auth.tenantId, auth.user.id, row, change, 'ui', body.reason);
      await audit.record({
        action: 'rule.update',
        entityType: 'rule',
        entityId: next.id,
        before: {
          key: row.key,
          ruleset,
          version: row.version,
          value: row.value,
          definition: row.definition,
          clause_ref: row.clauseRef,
          verified: row.verified,
        },
        after: {
          key: next.key,
          ruleset,
          version: next.version,
          value: next.value,
          definition: next.definition,
          clause_ref: next.clauseRef,
          verified: false,
          reason: body.reason,
        },
      });
      return toDto(next, ruleset);
    },
  );

  api.readPost(
    '/api/rules/import/preview',
    {
      summary: 'Validate a JS rule-values CSV (nothing is written to the rules)',
      capability: 'rules.edit',
      body: importBody,
    },
    async ({ auth, body, db }) => {
      const current = await currentRules(db, auth.tenantId);
      const refs = new Set(current.map((c) => `${c.ruleset}:${c.row.key}`));
      const js = current
        .filter((c) => c.ruleset === 'JS')
        .map(({ row }) => ({
          id: row.id,
          key: row.key,
          kind: row.kind,
          requirementClass: row.requirementClass,
          units: row.units,
          version: row.version,
          value: row.value,
          definition: row.definition,
          inherits: row.inherits,
          clauseRef: row.clauseRef,
        }));
      const preview = previewCsv(body.csv, js, (ref) => refs.has(ref));
      // The validated preview is stored immutably so the commit applies exactly what the user reviewed.
      const [batch] = await db
        .insert(schema.ruleImportBatches)
        .values({
          tenantId: auth.tenantId,
          kind: 'js_csv',
          filename: body.filename ?? null,
          rows: preview.rows,
          summary: { ...preview.summary, fileErrors: preview.fileErrors },
          status: 'previewed',
          createdBy: auth.user.id,
        })
        .returning();
      return { batchId: batch!.id, ...preview };
    },
  );

  api.mutate(
    'post',
    '/api/rules/import/commit',
    {
      summary: 'Apply a previewed CSV import (all or nothing; new versions are unverified)',
      capability: 'rules.edit',
      after: ({ auth }) =>
        api.jobs.enqueue(
          'rule-change',
          { tenantId: auth.tenantId },
          { singletonKey: `rules:${auth.tenantId}`, delaySeconds: api.jobDelaySeconds * 6 },
        ),
      body: commitBody,
    },
    async ({ auth, body, tx, audit }) => {
      const [batch] = await tx
        .select()
        .from(schema.ruleImportBatches)
        .where(
          and(
            eq(schema.ruleImportBatches.id, body.batchId),
            eq(schema.ruleImportBatches.tenantId, auth.tenantId),
          ),
        )
        .for('update');
      if (!batch) throw notFound('Import batch not found');
      if (batch.status !== 'previewed') throw conflict('This import was already committed');
      const summary = batch.summary as { errors: number; fileErrors: string[] };
      if (summary.errors > 0 || summary.fileErrors.length > 0)
        throw Object.assign(conflict('The preview has errors; fix the file and preview again'), {
          status: 422,
          code: 'preview_has_errors',
        });
      const rows = batch.rows as import('../rules/csv').ImportRow[];
      let applied = 0;
      for (const r of rows) {
        if (r.status !== 'ok' || !r.ruleId || !r.proposed) continue;
        const { row, ruleset } = await getCurrentById(tx, auth.tenantId, r.ruleId);
        if (!row.isCurrent || row.version !== r.baseVersion)
          throw conflict(`${r.ruleKey} changed since the preview; preview the file again`);
        const next = await supersede(
          tx,
          auth.tenantId,
          auth.user.id,
          row,
          { ...r.proposed, clauseRef: r.proposed.clauseRef },
          'csv',
          `CSV import ${batch.filename ?? batch.id}`,
        );
        await audit.record({
          action: 'rule.update',
          entityType: 'rule',
          entityId: next.id,
          before: {
            key: row.key,
            ruleset,
            version: row.version,
            value: row.value,
            definition: row.definition,
            clause_ref: row.clauseRef,
            verified: row.verified,
          },
          after: {
            key: next.key,
            ruleset,
            version: next.version,
            value: next.value,
            definition: next.definition,
            clause_ref: next.clauseRef,
            verified: false,
            import_batch: batch.id,
          },
        });
        applied += 1;
      }
      await tx
        .update(schema.ruleImportBatches)
        .set({ status: 'committed', committedAt: new Date() })
        .where(eq(schema.ruleImportBatches.id, batch.id));
      await audit.record({
        action: 'rule_import.commit',
        entityType: 'rule_import_batch',
        entityId: batch.id,
        after: { applied, unchanged: (batch.summary as { unchanged: number }).unchanged },
      });
      return { applied };
    },
  );

  api.readPost(
    '/api/rules/resolve',
    {
      summary:
        'Resolve the requirements that apply to a request context (ACI / JS / Both, with project overrides)',
      capability: 'rules.read',
      body: resolveBody,
    },
    async ({ auth, body, db }) => {
      const rules = await loadCurrentRecords(db, auth.tenantId);
      const result = resolve(rules, {
        mode: body.mode,
        context: body.context,
        projectOverrides: body.project_overrides as never,
        tablePolicy: body.table_policy,
      });
      return { ...result, blockers: approvalBlockers(result) };
    },
  );
}
