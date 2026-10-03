// The design lifecycle on the server (01-domain §14.1): gates, evidence, e-signatures, versions. The pure rules
// live in the engine (`canTransition`, `checkApprovalGates`, `evaluateTrialAcceptance`, `classifyChange`); this
// file gathers the facts, asks, and stores the answer in the append-only `design_transitions` row.
import { createHash } from 'node:crypto';
import { schema, type AuditRecorder, type Executor, type Tx } from '@khalta/db';
import {
  canTransition,
  checkApprovalGates,
  evaluateTrialAcceptance,
  type DesignFacts,
  type DesignState,
  type EvidenceKind,
  type Gate,
  type TrialBatch,
  type TrialCriteria,
} from '@khalta/engine';
import type { EvaluationReport, EvaluationSnapshot } from '@khalta/engine';
import { asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { ApiError } from '../errors';
import type { AuthContext } from '../middleware';
import { buildSnapshot, runEvaluation, type DesignRow } from '../evaluation/service';
import { loadCurrentRecords } from '../rules/service';
import { loadSettings } from '../settings';

export const esignBody = z.strictObject({ reason: z.string().trim().min(5).max(500) });
export type EsignBody = z.infer<typeof esignBody>;

export type Meaning =
  | 'trial_reviewed'
  | 'approved'
  | 'released'
  | 'retired'
  | 'suspended'
  | 'reinstated'
  | 'declared_values_accepted';

/** A typed e-signature: who, in what role, meaning what, why, and bound to the exact design version. */
export interface ESignature {
  signerId: string;
  signerName: string;
  role: string;
  meaning: Meaning;
  reason: string;
  designVersionHash: string;
  at: string;
}

type Line = typeof schema.mixDesignLines.$inferSelect;

export async function designLines(db: Executor, designId: string): Promise<Line[]> {
  return db
    .select()
    .from(schema.mixDesignLines)
    .where(eq(schema.mixDesignLines.designId, designId))
    .orderBy(asc(schema.mixDesignLines.sourceLine), asc(schema.mixDesignLines.materialId));
}

/** What a signature binds to: the design's identity, requirements and proportions (never prices). */
export function versionHash(d: DesignRow, lines: Line[]): string {
  const canon = JSON.stringify({
    code: d.code,
    version: d.version,
    plantId: d.plantId,
    requirements: d.requirements,
    lines: lines
      .map((l) => [l.materialId, Number(l.quantityKgM3).toFixed(3)])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
  });
  return createHash('sha256').update(canon).digest('hex');
}

export async function makeSignature(
  tx: Executor,
  auth: AuthContext,
  d: DesignRow,
  meaning: Meaning,
  reason: string,
): Promise<ESignature> {
  const [u] = await tx
    .select({ name: schema.users.name })
    .from(schema.users)
    .where(eq(schema.users.id, auth.user.id));
  return {
    signerId: auth.user.id,
    signerName: u?.name ?? auth.user.id,
    role: auth.role,
    meaning,
    reason,
    designVersionHash: versionHash(d, await designLines(tx, d.id)),
    at: new Date().toISOString(),
  };
}

export const ruleNumber = (
  rules: { ruleset: string; key: string; value: unknown }[],
  key: string,
) => {
  const r = rules.find((x) => x.ruleset === 'ENGINEERING' && x.key === key);
  return typeof r?.value === 'number' && Number.isFinite(r.value) ? r.value : null;
};

export async function trialCriteria(db: Executor, tenantId: string): Promise<TrialCriteria> {
  const rules = await loadCurrentRecords(db, tenantId);
  return {
    slumpToleranceMm: ruleNumber(rules, 'eng.trial.slump_tolerance_mm'),
    airTolerancePct: ruleNumber(rules, 'eng.trial.air_tolerance_pct'),
    densityBandKgM3: ruleNumber(rules, 'eng.trial.density_band_kg_m3'),
    yieldBandM3: ruleNumber(rules, 'eng.trial.yield_band_m3'),
    temperatureMaxC: ruleNumber(rules, 'eng.trial.temperature_max_c'),
  };
}

export async function trialBatchesOf(db: Executor, designId: string): Promise<TrialBatch[]> {
  const [d] = await db
    .select({ requirements: schema.mixDesigns.requirements })
    .from(schema.mixDesigns)
    .where(eq(schema.mixDesigns.id, designId));
  const age = (d?.requirements as { testAgeDays?: number | null } | undefined)?.testAgeDays ?? null;
  const rows = await db
    .select()
    .from(schema.trialBatches)
    .where(eq(schema.trialBatches.designId, designId))
    .orderBy(asc(schema.trialBatches.batchedOn), asc(schema.trialBatches.createdAt));
  const results = await db
    .select()
    .from(schema.strengthResults)
    .where(eq(schema.strengthResults.designId, designId));
  const n = (v: string | null) => (v === null ? null : Number(v));
  return rows.map((r) => ({
    id: r.id,
    batchedOn: r.batchedOn,
    slumpMm: n(r.slumpMm),
    airPct: n(r.airPct),
    temperatureC: n(r.temperatureC),
    freshDensityKgM3: n(r.freshDensityKgM3),
    yieldM3: n(r.yieldM3),
    // only the specimens of this batch cast for the design's test age are judged (others are stored and shown)
    strengthMpa: results
      .filter((x) => x.trialBatchId === r.id && age !== null && x.ageDays === age)
      .map((x) => Number(x.resultMpa)),
  }));
}

const idVersions = (rules: { id: string; version: number }[]) =>
  rules.map((r) => `${r.id}@${r.version}`).sort();

/** A fresh evaluation on current inputs, compared with the latest stored one (no side effects). */
export async function freshEvidence(tx: Executor, auth: AuthContext, d: DesignRow) {
  const [stored] = d.lastEvaluationId
    ? await tx
        .select()
        .from(schema.designEvaluations)
        .where(eq(schema.designEvaluations.id, d.lastEvaluationId))
    : [];
  const prev = stored?.snapshot as EvaluationSnapshot | undefined;
  const mode = stored?.mode ?? (d.rulesetMode as 'ACI' | 'JS' | 'BOTH' | null) ?? 'BOTH';
  const snapshot = await buildSnapshot(tx, auth.tenantId, d, {
    mode,
    s3Option: prev?.request.s3Option ?? null,
    airPct: prev?.request.airPct ?? null,
    projectOverrides: prev?.projectOverrides ?? [],
  });
  if (prev) snapshot.characteristics = prev.characteristics ?? [];
  const { report, validator } = runEvaluation(snapshot);
  const testsOf = (s: EvaluationSnapshot) =>
    Object.fromEntries(s.materials.flatMap((m) => (m.test ? [[m.id, m.test.version]] : [])));
  const rulesMatch =
    !!prev &&
    JSON.stringify(
      idVersions((stored!.ruleVersions as { id: string; version: number }[]) ?? []),
    ) === JSON.stringify(idVersions(snapshot.rules));
  const testsMatch =
    !!prev && JSON.stringify(sortObj(testsOf(prev))) === JSON.stringify(sortObj(testsOf(snapshot)));
  return { report, validator, snapshot, hasStored: !!stored, rulesMatch, testsMatch };
}
const sortObj = (o: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));

export interface GateReport {
  to: string;
  /** The graph's own verdict for the edge (illegal / not yet available / needs evidence). */
  edge: { ok: boolean; reason?: string; code?: string };
  gates: Gate[];
  ok: boolean;
}

const refusal = (from: string, to: string, evidence: EvidenceKind[]) => {
  const v = canTransition(from, to, evidence);
  return v.ok ? { ok: true as const } : { ok: false as const, reason: v.reason, code: v.code };
};

/** The checklist for moving `d` to `to`, without moving it. */
export async function gatesFor(
  tx: Executor,
  auth: AuthContext,
  d: DesignRow,
  to: string,
): Promise<GateReport & { _fresh?: Awaited<ReturnType<typeof freshEvidence>> }> {
  if (to === 'trial_in_progress') {
    const batches = await trialBatchesOf(tx, d.id);
    const gates: Gate[] = [
      {
        id: 'trial_batch',
        met: batches.length > 0,
        code: batches.length ? 'ok' : 'no_trial_batch',
      },
    ];
    const edge = refusal(d.status, to, ['trial_batch']);
    return { to, edge, gates, ok: edge.ok && gates.every((g) => g.met) };
  }
  if (to === 'trial_passed') {
    const fresh = await freshEvidence(tx, auth, d);
    const { gates } = trialGates(
      d,
      fresh.report,
      await trialCriteria(tx, auth.tenantId),
      await trialBatchesOf(tx, d.id),
    );
    const edge = refusal(d.status, to, ['trial_review']);
    return { to, edge, gates, ok: edge.ok && gates.every((g) => g.met) };
  }
  if (to === 'approved') {
    const fresh = await freshEvidence(tx, auth, d);
    const settings = await loadSettings(tx, auth.tenantId);
    const acceptances = await tx
      .select({ materials: schema.designAcceptances.materials })
      .from(schema.designAcceptances)
      .where(eq(schema.designAcceptances.designId, d.id));
    const accepted = acceptances.flatMap((a) =>
      ((a.materials as { materialId: string }[]) ?? []).map((m) => m.materialId),
    );
    const criteria = await trialCriteria(tx, auth.tenantId);
    const trial = trialGates(d, fresh.report, criteria, await trialBatchesOf(tx, d.id));
    const r = checkApprovalGates({
      authorId: d.createdBy,
      approverId: auth.user.id,
      status: d.status,
      evaluation: {
        validatorStatus: fresh.validator.status,
        verdict: fresh.report.verdict,
        provisional: fresh.report.provisional,
        evidence: fresh.report.evidence,
        dataQuality: fresh.report.dataQuality,
      },
      current: {
        hasStored: fresh.hasStored,
        rulesMatch: fresh.rulesMatch,
        testsMatch: fresh.testsMatch,
      },
      requiresLabSource: settings.approvalRequiresLabSource,
      acceptedMaterialIds: accepted,
      trial: trial.result,
    });
    const edge = refusal(d.status, to, ['four_eyes_approval']);
    return { to, edge, gates: r.gates, ok: edge.ok && r.ok, _fresh: fresh };
  }
  // release / retire / supersede: the graph and the role are the gate
  const kind: Record<string, EvidenceKind> = {
    in_production: 'release',
    retired: 'qc_decision',
    superseded: 'new_version_approved',
  };
  const edge = refusal(d.status, to, kind[to] ? [kind[to]!] : []);
  return { to, edge, gates: [], ok: edge.ok };
}

/** Trial acceptance against the stored targets; `ok` also needs QC sign-off, which is the act of passing. */
function trialGates(
  d: DesignRow,
  report: EvaluationReport,
  criteria: TrialCriteria,
  batches: TrialBatch[],
) {
  const req = d.requirements as { slumpMm?: number | null; airPct?: number | null };
  const density = report.trace.find((t) => t.key === 'mass.fresh_density')?.value;
  const result = evaluateTrialAcceptance(
    criteria,
    {
      slumpMm: req.slumpMm ?? null,
      airPct: req.airPct ?? null,
      densityKgM3: typeof density === 'number' ? density : null,
      fcrMpa: report.strengthAdequacy.fcrMpa,
    },
    batches,
  );
  const gates: Gate[] = [
    ...(result.batchId === null
      ? [{ id: 'trial_passed', met: false, code: 'no_trial_batch' } as Gate]
      : []),
    ...result.criteria.map((c) => ({
      id: `criterion_${c.id}` as Gate['id'],
      met: c.status === 'pass' || c.status === 'not_applicable',
      code: c.status,
      detail: c.missing ? [c.missing] : [],
    })),
  ];
  return { gates, result };
}
/** Move a design along one edge: the graph decides, the transition row records who, why and the signature. */
export async function applyTransition(
  tx: Tx,
  auth: AuthContext,
  audit: AuditRecorder,
  d: DesignRow,
  to: DesignState,
  evidence: EvidenceKind[],
  detail: Record<string, unknown>,
  esignature: ESignature | null,
  set: Partial<typeof schema.mixDesigns.$inferInsert> = {},
) {
  const v = canTransition(d.status, to, evidence);
  if (!v.ok) throw new ApiError(409, v.code, v.reason);
  await tx
    .update(schema.mixDesigns)
    .set({ status: to, updatedAt: new Date(), ...set })
    .where(eq(schema.mixDesigns.id, d.id));
  await tx.insert(schema.designTransitions).values({
    tenantId: auth.tenantId,
    designId: d.id,
    fromStatus: d.status,
    toStatus: to,
    actorId: auth.user.id,
    evidence: { kind: evidence[0], kinds: evidence, ...detail },
    esignature,
  });
  await audit.record({
    action: `design.${to}`,
    entityType: 'mix_design',
    entityId: d.id,
    before: { status: d.status },
    after: { status: to, meaning: esignature?.meaning ?? null },
  });
}

export async function loadFacts(tx: Executor, d: DesignRow): Promise<DesignFacts> {
  const lines = await tx
    .select({
      materialId: schema.mixDesignLines.materialId,
      kg: schema.mixDesignLines.quantityKgM3,
      category: schema.materials.category,
    })
    .from(schema.mixDesignLines)
    .innerJoin(schema.materials, eq(schema.materials.id, schema.mixDesignLines.materialId))
    .where(eq(schema.mixDesignLines.designId, d.id));
  const [ev] = d.lastEvaluationId
    ? await tx
        .select({
          ruleVersions: schema.designEvaluations.ruleVersions,
          testVersions: schema.designEvaluations.testVersions,
          priceBasis: schema.designEvaluations.priceBasis,
        })
        .from(schema.designEvaluations)
        .where(eq(schema.designEvaluations.id, d.lastEvaluationId))
    : [];
  return {
    lines: lines.map((l) => ({ materialId: l.materialId, kg: Number(l.kg), category: l.category })),
    requirements: d.requirements,
    ruleVersions: Object.fromEntries(
      ((ev?.ruleVersions as { id: string; version: number }[]) ?? []).map((r) => [r.id, r.version]),
    ),
    testVersions: (ev?.testVersions as Record<string, number>) ?? {},
    priceBasis: ev ? JSON.stringify(ev.priceBasis) : null,
  };
}
