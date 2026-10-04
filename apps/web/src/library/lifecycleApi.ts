import { queryOptions } from '@tanstack/react-query';
import { api } from '../lib/api';

export type Target = 'trial_in_progress' | 'trial_passed' | 'approved';
export type Action =
  'start-trial' | 'pass-trial' | 'approve' | 'release' | 'retire' | 'suspend' | 'reinstate';

export interface Gate {
  id: string;
  met: boolean;
  code: string;
  detail?: string[];
}
export interface GateReport {
  to: string;
  edge: { ok: boolean; reason?: string; code?: string };
  gates: Gate[];
  ok: boolean;
  /** What the server demands for this move, who may do it, the four outcomes and the evidence states. */
  policy?: {
    outcome: string | null;
    capability: string;
    separation: 'author' | 'none';
    signature: string | null;
  } | null;
  permitted?: { ok: boolean; reasons: ('capability' | 'plant_scope' | 'author_cannot_act')[] };
  outcomes?: {
    calculationChecks: 'none' | 'passed' | 'failed' | 'incomplete' | 'stale';
    trialAccepted: boolean;
    approved: boolean;
    released: boolean;
  };
  evidence?: {
    assumed: string[];
    conventions: string[];
    declared: string[];
    missing: string[];
    modelPredicted: string[];
  };
}

export const gatesQuery = (id: string, to: Target) =>
  queryOptions({
    queryKey: ['designs', 'gates', id, to],
    queryFn: () => api<GateReport>(`/api/designs/${id}/gates?to=${to}`),
  });

const post = <T>(path: string, body?: unknown) =>
  api<T>(path, { method: 'POST', body: JSON.stringify(body ?? {}) });

/**
 * `idempotencyKey` makes a retry of the SAME action harmless (the server returns the first outcome); `expectedStatus`
 * makes the server refuse when the design changed since the person loaded it.
 */
export const runAction = (
  id: string,
  action: Action,
  reason: string,
  guard?: { idempotencyKey: string; expectedStatus: string },
) => post<{ id: string; status: string }>(`/api/designs/${id}/${action}`, { reason, ...guard });
export const acceptAssumptions = (id: string, reason: string) =>
  post<{ id: string; assumptions: string[] }>(`/api/designs/${id}/accept-assumptions`, { reason });
export const startTrial = (id: string) =>
  post<{ id: string; status: string }>(`/api/designs/${id}/start-trial`);
export const acceptDeclared = (id: string, reason: string) =>
  post<{ id: string }>(`/api/designs/${id}/accept-declared`, { reason });
