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
}

export const gatesQuery = (id: string, to: Target) =>
  queryOptions({
    queryKey: ['designs', 'gates', id, to],
    queryFn: () => api<GateReport>(`/api/designs/${id}/gates?to=${to}`),
  });

const post = <T>(path: string, body?: unknown) =>
  api<T>(path, { method: 'POST', body: JSON.stringify(body ?? {}) });

export const runAction = (id: string, action: Action, reason: string) =>
  post<{ id: string; status: string }>(`/api/designs/${id}/${action}`, { reason });
export const startTrial = (id: string) =>
  post<{ id: string; status: string }>(`/api/designs/${id}/start-trial`);
export const acceptDeclared = (id: string, reason: string) =>
  post<{ id: string }>(`/api/designs/${id}/accept-declared`, { reason });
