import { queryOptions } from '@tanstack/react-query';
import type { EvaluationReport, ValidatorResult } from '@khalta/engine';
import { api } from '../lib/api';

export type DesignStatus =
  | 'draft'
  | 'evaluated'
  | 'trial_candidate'
  | 'trial_in_progress'
  | 'trial_passed'
  | 'approved'
  | 'in_production'
  | 'suspended'
  | 'superseded'
  | 'retired';
export interface Issue {
  code: string;
  line?: number;
  detail?: string;
}
export interface DesignCard {
  id: string;
  code: string;
  name: string;
  plantId: string;
  version: number;
  status: DesignStatus;
  approvalSource: 'khalta' | 'legacy_attested' | null;
  externalApprovalRef: string | null;
  approvedAt: string | null;
  evaluationPending: boolean;
  needsRevalidation: boolean;
  lastVerdict: 'fail' | 'incomplete' | 'pass' | null;
  lastEvaluatedAt: string | null;
  requirements: {
    fcMpa?: number;
    basis?: string;
    testAgeDays?: number;
    exposure?: string[];
    slumpMm?: number;
    nmasMm?: number;
    pumpable?: boolean;
  };
  importedApprovalRef: string | null;
  importedInProduction: boolean | null;
  avgMonthlyVolumeM3: string | null;
  warnings: Issue[];
  synthetic: boolean;
  createdBy: string | null;
}
export interface DesignLine {
  id: string;
  materialId: string;
  nameEn: string;
  nameAr: string | null;
  category: string;
  quantityKgM3: string;
  originalQuantity: string;
  originalUnit: 'kg/m3' | 'L/m3';
  originalName: string;
  sourceLine: number | null;
  matchMethod: 'exact' | 'confirmed' | 'created';
}
export interface DesignIdentity {
  versionHash: string | null;
  requirementsRef: string | null;
  requirementsStatus: 'draft' | 'verified' | 'superseded' | null;
}
export interface DesignDetail {
  identity?: DesignIdentity;
  design: DesignCard & { importBatchId: string | null };
  lines: DesignLine[];
  transitions: {
    id: string;
    fromStatus: string;
    toStatus: string;
    evidence: Record<string, unknown>;
    esignature: { meaning: string; signerName: string; reason: string } | null;
    at: string;
    actor: string | null;
  }[];
  source: string | null;
}

export const designsQuery = (params: Record<string, string | undefined> = {}) => {
  const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v) as [string, string][]);
  return queryOptions({
    queryKey: ['designs', 'list', qs.toString()],
    queryFn: () => api<DesignCard[]>(`/api/designs${qs.size ? `?${qs}` : ''}`),
    staleTime: 10_000,
  });
};
export const designQuery = (id: string) =>
  queryOptions({
    queryKey: ['designs', 'one', id],
    queryFn: () => api<DesignDetail>(`/api/designs/${id}`),
  });
export const attestDesign = (
  id: string,
  body: { approvalReference: string; approvedOn?: string; inProduction: boolean; note: string },
) =>
  api<{ id: string; status: DesignStatus }>(`/api/designs/${id}/attest`, {
    method: 'POST',
    body: JSON.stringify(body),
  });

// ---- evaluations (M2.1)
export interface EvaluationListItem {
  id: string;
  createdAt: string;
  mode: 'ACI' | 'JS' | 'BOTH';
  verdict: 'fail' | 'incomplete' | 'pass';
  provisional: boolean;
  validatorStatus: 'pass' | 'fail';
  minimumDataOk: boolean;
  costJodPerM3: string | null;
  actor: string | null;
}
export interface EvaluationDetail {
  id: string;
  createdAt: string;
  mode: 'ACI' | 'JS' | 'BOTH';
  verdict: 'fail' | 'incomplete' | 'pass';
  provisional: boolean;
  validatorStatus: 'pass' | 'fail';
  report: EvaluationReport;
  validator: ValidatorResult;
  inputsChanged: {
    materials: { materialId: string; evaluated: number; current: number | null }[];
    rules: number;
  };
  priceBasis: unknown;
}
export interface EvaluateBody {
  mode: 'ACI' | 'JS' | 'BOTH';
  s3Option?: 1 | 2;
  airPct?: number;
}
export interface EvaluateResult {
  evaluation: { id: string; verdict: string; validatorStatus: 'pass' | 'fail' };
  design: { id: string; status: DesignStatus; needsRevalidation: boolean };
  transition: { moved: boolean; blocker: 'validator_failed' | 'minimum_data_missing' | null };
}
export const evaluationsQuery = (id: string) =>
  queryOptions({
    queryKey: ['designs', 'evaluations', id],
    queryFn: () => api<EvaluationListItem[]>(`/api/designs/${id}/evaluations`),
  });
export const evaluationQuery = (id: string, evalId: string) =>
  queryOptions({
    queryKey: ['designs', 'evaluation', id, evalId],
    queryFn: () => api<EvaluationDetail>(`/api/designs/${id}/evaluations/${evalId}`),
  });
export const evaluateDesign = (id: string, body: EvaluateBody) =>
  api<EvaluateResult>(`/api/designs/${id}/evaluate`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
