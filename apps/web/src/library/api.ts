import { queryOptions } from '@tanstack/react-query';
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
export interface DesignDetail {
  design: DesignCard & { importBatchId: string | null };
  lines: DesignLine[];
  transitions: {
    id: string;
    fromStatus: string;
    toStatus: string;
    evidence: Record<string, unknown>;
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
