// Design lifecycle endpoints (F-022): trial, approval, release, retire, versions, diff, gates, declared-value
// acceptance. Every move goes through `applyTransition` (the engine's graph decides; the database refuses the rest).
import { schema } from '@khalta/db';
import { assertNotAuthor, canAccessPlant, roleCan, type Capability } from '@khalta/rbac';
import { evidenceBreakdown, policyFor } from '@khalta/engine';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { ApiError, notFound } from '../errors';
import type { ApiRoutes } from '../route';
import { loadDesign } from '../evaluation/run';
import { createApprovedEntry } from '../savings/service';
import {
  applyTransition,
  esignBody,
  freshEvidence,
  acceptedAssumptionsOf,
  gatesFor,
  guardRequest,
  makeSignature,
  releaseRecord,
  trialBatchesOf,
} from '../lifecycle/service';

const idParam = z.object({ id: z.uuid() });
const gatesQuery = z.object({
  to: z.enum([
    'trial_in_progress',
    'trial_passed',
    'approved',
    'in_production',
    'retired',
    'superseded',
  ]),
});
/** Checks the edge and every gate; throws 409 with the whole checklist when anything is unmet. */
function assertReady(r: Awaited<ReturnType<typeof gatesFor>>) {
  if (!r.edge.ok)
    throw new ApiError(409, r.edge.code ?? 'conflict', r.edge.reason ?? 'Not allowed');
  if (!r.gates.every((g) => g.met))
    throw new ApiError(409, 'gates_unmet', 'Some conditions are not met', { gates: r.gates });
}

export function lifecycleRoutes(api: ApiRoutes) {
  api.get(
    '/api/designs/:id/gates',
    {
      summary: 'The checklist for moving a design to a target state (nothing is changed)',
      capability: 'library.read',
      params: idParam,
      query: gatesQuery,
    },
    async ({ auth, params, query, db }) => {
      const d = await loadDesign(db, auth, params.id);
      const p = policyFor(query.to);
      const { _fresh, ...rest } = await gatesFor(db, auth, d, query.to, {
        capability: p ? roleCan(auth.role, p.capability as Capability, auth.settings) : true,
        plantScope: p?.scope === 'tenant' || canAccessPlant(auth.scope, d.plantId),
      });
      void _fresh;
      return rest;
    },
  );

  api.mutate(
    'post',
    '/api/designs/:id/start-trial',
    {
      summary: 'Trial candidate → trial in progress (needs at least one logged trial batch)',
      capability: 'trial.request',
      params: idParam,
    },
    async ({ auth, params, tx, audit }) => {
      const d = await loadDesign(tx, auth, params.id, true);
      assertReady(await gatesFor(tx, auth, d, 'trial_in_progress'));
      const batches = await trialBatchesOf(tx, d.id);
      await applyTransition(
        tx,
        auth,
        audit,
        d,
        'trial_in_progress',
        ['trial_batch'],
        {
          batchIds: batches.map((b) => b.id),
        },
        null,
      );
      return { id: d.id, status: 'trial_in_progress' };
    },
  );

  api.mutate(
    'post',
    '/api/designs/:id/pass-trial',
    {
      summary:
        'Trial in progress → trial passed: every acceptance criterion met, QC manager signs off',
      capability: 'trial.pass',
      params: idParam,
      body: esignBody,
    },
    async ({ auth, params, body, tx, audit }) => {
      const d = await loadDesign(tx, auth, params.id, true);
      const again = await guardRequest(tx, auth, d, body);
      if (again) {
        await audit.record({
          action: 'design.request_replayed',
          entityType: 'mix_design',
          entityId: d.id,
          after: { status: again.toStatus, transitionId: again.transitionId },
        });
        return { id: d.id, status: again.toStatus, replayed: true };
      }
      const r = await gatesFor(tx, auth, d, 'trial_passed');
      assertReady(r);
      const sig = await makeSignature(tx, auth, d, 'trial_reviewed', body.reason);
      await applyTransition(
        tx,
        auth,
        audit,
        d,
        'trial_passed',
        ['trial_review'],
        {
          criteria: r.gates.map((g) => ({ id: g.id, code: g.code })),
        },
        sig,
        {},
        body.idempotencyKey,
      );
      return { id: d.id, status: 'trial_passed' };
    },
  );

  api.mutate(
    'post',
    '/api/designs/:id/accept-declared',
    {
      summary:
        'A QC manager accepts the user-declared key values of this design (e-signature, 07 §2.5)',
      capability: 'design.approve',
      params: idParam,
      body: esignBody,
      status: 201,
    },
    async ({ auth, params, body, tx, audit }) => {
      const d = await loadDesign(tx, auth, params.id, true);
      if (['superseded', 'retired'].includes(d.status))
        throw new ApiError(409, 'conflict', `A ${d.status} design cannot be changed`);
      const fresh = await freshEvidence(tx, auth, d);
      const declared = fresh.report.dataQuality.filter(
        (q) => q.code === 'declared_values' && q.materialId,
      );
      if (declared.length === 0)
        throw new ApiError(
          409,
          'conflict',
          'This design has no user-declared key values to accept',
        );
      const materials = declared.map((q) => ({
        materialId: q.materialId,
        fields: String(q.detail ?? '')
          .replace(/^user-declared key values:\s*/, '')
          .split(',')
          .map((x) => x.trim())
          .filter(Boolean),
      }));
      const sig = await makeSignature(tx, auth, d, 'declared_values_accepted', body.reason);
      const [row] = await tx
        .insert(schema.designAcceptances)
        .values({
          tenantId: auth.tenantId,
          designId: d.id,
          materials,
          esignature: sig,
          acceptedBy: auth.user.id,
        })
        .returning({ id: schema.designAcceptances.id });
      await audit.record({
        action: 'design.accept_declared',
        entityType: 'mix_design',
        entityId: d.id,
        after: { materials },
      });
      return { id: row!.id, materials };
    },
  );

  api.mutate(
    'post',
    '/api/designs/:id/accept-assumptions',
    {
      summary:
        'A QC manager accepts, with an e-signature, the assumptions the evaluator made for this design (they never satisfy approval silently)',
      capability: 'design.approve',
      params: idParam,
      body: esignBody,
      status: 201,
    },
    async ({ auth, params, body, tx, audit }) => {
      const d = await loadDesign(tx, auth, params.id, true);
      if (['superseded', 'retired'].includes(d.status))
        throw new ApiError(409, 'conflict', `A ${d.status} design cannot be changed`);
      const fresh = await freshEvidence(tx, auth, d);
      const already = await acceptedAssumptionsOf(tx, d.id);
      const open = evidenceBreakdown({
        assumptions: fresh.report.assumptions,
        assumptionReasons: fresh.report.assumptionReasons,
        evidence: fresh.report.evidence,
        dataQuality: fresh.report.dataQuality,
      }).assumed.filter((a) => !already.includes(a));
      if (open.length === 0)
        throw new ApiError(
          409,
          'conflict',
          'This design has no assumptions waiting for acceptance',
        );
      const sig = await makeSignature(tx, auth, d, 'assumptions_accepted', body.reason);
      const [row] = await tx
        .insert(schema.designAcceptances)
        .values({
          tenantId: auth.tenantId,
          designId: d.id,
          kind: 'assumptions',
          materials: [],
          assumptions: open,
          esignature: sig,
          acceptedBy: auth.user.id,
        })
        .returning({ id: schema.designAcceptances.id });
      await audit.record({
        action: 'design.accept_assumptions',
        entityType: 'mix_design',
        entityId: d.id,
        after: { assumptions: open },
      });
      return { id: row!.id, assumptions: open };
    },
  );

  api.mutate(
    'post',
    '/api/designs/:id/approve',
    {
      summary:
        'Trial passed → approved: four-eyes, every gate met, e-signed. Lists every unmet gate otherwise',
      capability: 'design.approve',
      params: idParam,
      body: esignBody,
    },
    async ({ auth, params, body, tx, audit }) => {
      const d = await loadDesign(tx, auth, params.id, true);
      const again = await guardRequest(tx, auth, d, body);
      if (again) {
        await audit.record({
          action: 'design.request_replayed',
          entityType: 'mix_design',
          entityId: d.id,
          after: { status: again.toStatus, transitionId: again.transitionId },
        });
        return { id: d.id, status: again.toStatus, replayed: true };
      }
      assertNotAuthor(auth.user.id, d.createdBy); // the author never approves their own design
      const r = await gatesFor(tx, auth, d, 'approved');
      assertReady(r);
      const sig = await makeSignature(tx, auth, d, 'approved', body.reason);
      const now = new Date();
      await applyTransition(
        tx,
        auth,
        audit,
        d,
        'approved',
        ['four_eyes_approval'],
        {
          gates: r.gates.map((g) => ({ id: g.id, code: g.code })),
          evaluatorVersion: r._fresh?.report.evaluatorVersion ?? null,
          validatorVersion: r._fresh?.validator.validatorVersion ?? null,
        },
        sig,
        { approvalSource: 'khalta', approvedBy: auth.user.id, approvedAt: now },
        body.idempotencyKey,
      );
      // A new version's approval supersedes the version it came from (§14.1 `superseded`).
      let superseded: string | null = null;
      if (d.parentDesignId) {
        const [parent] = await tx
          .select()
          .from(schema.mixDesigns)
          .where(eq(schema.mixDesigns.id, d.parentDesignId))
          .for('update');
        if (parent && ['approved', 'in_production', 'suspended'].includes(parent.status)) {
          await applyTransition(
            tx,
            auth,
            audit,
            parent,
            'superseded',
            ['new_version_approved'],
            { supersededBy: d.id, version: d.version },
            null,
          );
          superseded = parent.id;
        }
      }
      // The APPROVED saving, if this version replaces a baselined design (a failure here never blocks the approval).
      let savings: unknown = { state: 'skipped', reason: 'not_a_version' };
      try {
        await tx.transaction(async (sp) => {
          savings = await createApprovedEntry(sp as typeof tx, audit, auth, {
            ...d,
            status: 'approved',
          });
        });
      } catch (e) {
        if (process.env['DEBUG_SAVINGS']) console.error(e);
        savings = { state: 'skipped', reason: 'cost_incomplete' };
      }
      return { id: d.id, status: 'approved', superseded, savings };
    },
  );

  api.mutate(
    'post',
    '/api/designs/:id/release',
    {
      summary:
        'Approved → in production at its plant (QC manager, or the plant manager of that plant)',
      capability: 'production.release',
      params: idParam,
      body: esignBody,
    },
    async ({ auth, params, body, tx, audit }) => {
      const d = await loadDesign(tx, auth, params.id, true);
      const again = await guardRequest(tx, auth, d, body);
      if (again) {
        await audit.record({
          action: 'design.request_replayed',
          entityType: 'mix_design',
          entityId: d.id,
          after: { status: again.toStatus, transitionId: again.transitionId },
        });
        return { id: d.id, status: again.toStatus, replayed: true };
      }
      if (!canAccessPlant(auth.scope, d.plantId)) throw notFound('Design not found');
      assertReady(await gatesFor(tx, auth, d, 'in_production'));
      const sig = await makeSignature(tx, auth, d, 'released', body.reason);
      await applyTransition(
        tx,
        auth,
        audit,
        d,
        'in_production',
        ['release'],
        await releaseRecord(tx, auth, d),
        sig,
        {},
        body.idempotencyKey,
      );
      return { id: d.id, status: 'in_production' };
    },
  );

  api.mutate(
    'post',
    '/api/designs/:id/retire',
    {
      summary:
        'Retire a design (QC manager decision with a reason; allowed from any non-terminal state)',
      capability: 'design.approve',
      params: idParam,
      body: esignBody,
    },
    async ({ auth, params, body, tx, audit }) => {
      const d = await loadDesign(tx, auth, params.id, true);
      const again = await guardRequest(tx, auth, d, body);
      if (again) {
        await audit.record({
          action: 'design.request_replayed',
          entityType: 'mix_design',
          entityId: d.id,
          after: { status: again.toStatus, transitionId: again.transitionId },
        });
        return { id: d.id, status: again.toStatus, replayed: true };
      }
      assertReady(await gatesFor(tx, auth, d, 'retired'));
      const sig = await makeSignature(tx, auth, d, 'retired', body.reason);
      await applyTransition(
        tx,
        auth,
        audit,
        d,
        'retired',
        ['qc_decision'],
        { reason: body.reason },
        sig,
        {},
        body.idempotencyKey,
      );
      return { id: d.id, status: 'retired' };
    },
  );

  const decisionBody = esignBody;
  api.mutate(
    'post',
    '/api/designs/:id/suspend',
    {
      summary:
        'Suspend an approved or in-production design (QC manager decision with a reason; nothing suspends automatically)',
      capability: 'design.approve',
      params: idParam,
      body: decisionBody,
    },
    async ({ auth, params, body, tx, audit }) => {
      const d = await loadDesign(tx, auth, params.id, true);
      const again = await guardRequest(tx, auth, d, body);
      if (again) {
        await audit.record({
          action: 'design.request_replayed',
          entityType: 'mix_design',
          entityId: d.id,
          after: { status: again.toStatus, transitionId: again.transitionId },
        });
        return { id: d.id, status: again.toStatus, replayed: true };
      }
      const sig = await makeSignature(tx, auth, d, 'suspended', body.reason);
      await applyTransition(
        tx,
        auth,
        audit,
        d,
        'suspended',
        ['suspension_decision'],
        { reason: body.reason, previous: d.status },
        sig,
        {},
        body.idempotencyKey,
      );
      return { id: d.id, status: 'suspended' };
    },
  );

  api.mutate(
    'post',
    '/api/designs/:id/reinstate',
    {
      summary:
        'Reinstate a suspended design to approved or in production (QC manager decision with a reason)',
      capability: 'design.approve',
      params: idParam,
      body: decisionBody.extend({ to: z.enum(['approved', 'in_production']).default('approved') }),
    },
    async ({ auth, params, body, tx, audit }) => {
      const d = await loadDesign(tx, auth, params.id, true);
      const again = await guardRequest(tx, auth, d, body);
      if (again) {
        await audit.record({
          action: 'design.request_replayed',
          entityType: 'mix_design',
          entityId: d.id,
          after: { status: again.toStatus, transitionId: again.transitionId },
        });
        return { id: d.id, status: again.toStatus, replayed: true };
      }
      const sig = await makeSignature(tx, auth, d, 'reinstated', body.reason);
      await applyTransition(
        tx,
        auth,
        audit,
        d,
        body.to,
        ['reinstatement_decision'],
        { reason: body.reason },
        sig,
        {},
        body.idempotencyKey,
      );
      return { id: d.id, status: body.to };
    },
  );
}
