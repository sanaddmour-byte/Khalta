import type { EvaluationReport, ValidatorResult } from '@khalta/engine';
import { queryOptions } from '@tanstack/react-query';
import { api } from '../lib/api';
import type { DesignStatus } from './api';

export type Verdict = 'fail' | 'incomplete' | 'pass';
export type PortfolioFilter =
  'all' | 'failing' | 'incomplete' | 'not_evaluated' | 'revalidation' | 'inputs_changed';

export interface PortfolioRow {
  id: string;
  code: string;
  name: string;
  version: number;
  plantId: string;
  status: DesignStatus;
  approvalSource: 'khalta' | 'legacy_attested' | null;
  needsRevalidation: boolean;
  synthetic: boolean;
  avgMonthlyVolumeM3: string | null;
  evaluated: boolean;
  evaluatedAt: string | null;
  mode: string | null;
  verdict: Verdict | null;
  validatorStatus: 'pass' | 'fail' | null;
  provisional: boolean | null;
  failing: number;
  unevaluated: number;
  blockers: number;
  evidence: string[];
  inputsChanged: boolean;
  costJodPerM3: string | null;
}
export interface Portfolio {
  rows: PortfolioRow[];
  counts: {
    total: number;
    failing: number;
    incomplete: number;
    notEvaluated: number;
    revalidation: number;
    inputsChanged: number;
  };
}
export interface DataQuality {
  notEvaluated: number;
  groups: {
    code: string;
    severity: 'warning' | 'blocker';
    materialId: string | null;
    materialNameEn: string | null;
    materialNameAr: string | null;
    designs: { id: string; code: string }[];
  }[];
}
export interface VersionRow {
  id: string;
  version: number;
  status: DesignStatus;
  parentDesignId: string | null;
  lastVerdict: Verdict | null;
  needsRevalidation: boolean;
  createdAt: string;
}
export interface Diff {
  from: { id: string; version: number };
  to: { id: string; version: number };
  classes: string[];
  requiresTrial: boolean;
  lines: {
    materialId: string;
    nameEn: string;
    nameAr: string | null;
    from: string | null;
    to: string | null;
    change: 'added' | 'removed' | 'changed' | 'same';
  }[];
  requirements: { key: string; from: unknown; to: unknown }[];
}
export interface EditBody {
  mode?: 'ACI' | 'JS' | 'BOTH';
  requirements?: Record<string, unknown>;
  lines: { materialId: string; kgPerM3: string }[];
}
export interface Baseline {
  id: string;
  designId: string;
  code: string;
  version: number;
  plantId: string;
  snapshotId: string;
  snapshotName: string;
  asOf: string;
  costJodPerM3: string;
  monthlyVolumeM3: string | null;
  volumeSource: 'import_file' | null;
  annualJod: string | null;
  createdAt: string;
}
export interface SavingsEntry {
  id: string;
  state: 'theoretical';
  reasonCode: 'manual_variant';
  baselineId: string;
  baselineDesignId: string;
  variantDesignId: string;
  snapshotId: string;
  snapshotName: string;
  asOf: string;
  savingJodPerM3: string;
  monthlyVolumeM3: string | null;
  annualJod: string | null;
  provisional: boolean;
  code: string;
  variantVersion: number;
  createdAt: string;
}
export interface Opportunity {
  eligible: boolean;
  reasons: { code: string; detail?: unknown }[];
  evaluationId: string;
  entry?: { id: string; savingJodPerM3: string; annualJod: string | null };
}

const post = <T>(path: string, body: unknown) =>
  api<T>(path, { method: 'POST', body: JSON.stringify(body) });

export const portfolioQuery = (filter: PortfolioFilter, plantId?: string) =>
  queryOptions({
    queryKey: ['designs', 'portfolio', filter, plantId ?? ''],
    queryFn: () =>
      api<Portfolio>(`/api/portfolio?filter=${filter}${plantId ? `&plantId=${plantId}` : ''}`),
  });
export const dataQualityQuery = (plantId?: string) =>
  queryOptions({
    queryKey: ['designs', 'data-quality', plantId ?? ''],
    queryFn: () => api<DataQuality>(`/api/data-quality${plantId ? `?plantId=${plantId}` : ''}`),
  });
export const versionsQuery = (id: string) =>
  queryOptions({
    queryKey: ['designs', 'versions', id],
    queryFn: () => api<VersionRow[]>(`/api/designs/${id}/versions`),
  });
export const diffQuery = (a: string, b: string) =>
  queryOptions({
    queryKey: ['designs', 'diff', a, b],
    queryFn: () => api<Diff>(`/api/designs/${a}/diff/${b}`),
  });
export const baselinesQuery = queryOptions({
  queryKey: ['savings', 'baselines'],
  queryFn: () => api<Baseline[]>('/api/baselines'),
});
export const savingsQuery = queryOptions({
  queryKey: ['savings', 'entries'],
  queryFn: () => api<SavingsEntry[]>('/api/savings'),
});

export const evaluateBatch = (body: {
  mode: 'ACI' | 'JS' | 'BOTH';
  designIds?: string[];
  plantId?: string;
}) =>
  post<{ evaluated: number; results: { id: string; verdict: string; error?: string }[] }>(
    '/api/designs/evaluate-batch',
    body,
  );
export const previewEdit = (id: string, body: EditBody) =>
  post<{ report: EvaluationReport; validator: ValidatorResult }>(
    `/api/designs/${id}/preview`,
    body,
  );
export const createVersion = (id: string, body: EditBody & { note: string }) =>
  post<{ id: string; version: number }>(`/api/designs/${id}/versions`, body);
export const createBaseline = (body: { designId: string; priceSnapshotId: string }) =>
  post<{ id: string; costJodPerM3: string }>('/api/baselines', body);
export const priceOpportunity = (body: { baselineId: string; variantDesignId: string }) =>
  post<Opportunity>('/api/savings/theoretical', body);

/** Download the logged CSV export. */
export async function exportPortfolio(filter: PortfolioFilter, plantId?: string) {
  const res = await fetch('/api/portfolio/export', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ filter, ...(plantId ? { plantId } : {}) }),
  });
  if (!res.ok) throw new Error(String(res.status));
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = 'khalta-portfolio.csv';
  a.click();
  URL.revokeObjectURL(url);
}
