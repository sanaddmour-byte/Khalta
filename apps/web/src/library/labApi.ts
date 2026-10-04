import { queryOptions } from '@tanstack/react-query';
import { api, ApiError } from '../lib/api';

export interface TrialBatch {
  id: string;
  batchedOn: string;
  slumpMm: string | null;
  airPct: string | null;
  temperatureC: string | null;
  freshDensityKgM3: string | null;
  yieldM3: string | null;
  waterAddedKgM3: string | null;
  notes: string | null;
  supersedesId: string | null;
}
export interface StrengthResult {
  id: string;
  trialBatchId: string | null;
  castDate: string;
  ageDays: number;
  specimenType: 'cylinder' | 'cube';
  setId: string;
  resultMpa: string;
}
export interface LabData {
  testAgeDays: number | null;
  fcMpa: number | null;
  fcrMpa: number | null;
  batches: TrialBatch[];
  results: StrengthResult[];
}
export interface BatchLine {
  materialId: string;
  category: string;
  kgSsd: number;
  kgOvenDry: number | null;
  kgBatch: number;
  freeWaterKg: number | null;
  solutionWaterKg: number | null;
}
export interface BatchBlocker {
  code: string;
  subject: string;
  detail: string;
}
export type BatchResult =
  | {
      ok: true;
      lines: BatchLine[];
      designWaterKg: number;
      freeWaterFromAggregatesKg: number;
      solutionWaterSubtractedKg: number;
      batchWaterKg: number;
      balance: {
        ssdTotalKg: number;
        batchTotalKg: number;
        expectedDifferenceKg: number;
        residualKg: number;
      };
      convention: { admixtureSolutionWater: boolean };
    }
  | { ok: false; blockers: BatchBlocker[] };
export interface Preview {
  result: BatchResult;
  validator: { status: 'pass' | 'fail'; mismatches: { key: string }[] };
}
export interface BatchInstance {
  id: string;
  kind: 'production' | 'trial';
  designVersion: number;
  result: BatchResult;
  validatorStatus: 'pass' | 'fail';
  createdAt: string;
  actor: string | null;
}
export interface MoistureRow {
  materialId: string;
  totalMoisturePct: number;
}

const post = <T>(path: string, body?: unknown) =>
  api<T>(path, { method: 'POST', body: JSON.stringify(body ?? {}) });

export const labQuery = (id: string) =>
  queryOptions({
    queryKey: ['designs', 'lab', id],
    queryFn: () => api<LabData>(`/api/designs/${id}/trial-batches`),
  });
export const instancesQuery = (id: string) =>
  queryOptions({
    queryKey: ['designs', 'batch-instances', id],
    queryFn: () => api<BatchInstance[]>(`/api/designs/${id}/batch-instances`),
  });
export const addBatch = (id: string, body: Record<string, unknown>) =>
  post<{ id: string }>(`/api/designs/${id}/trial-batches`, body);
export const addResults = (batchId: string, body: Record<string, unknown>) =>
  post<{ ids: string[] }>(`/api/trial-batches/${batchId}/strength-results`, body);
export const previewBatch = (id: string, moisture: MoistureRow[]) =>
  post<Preview>(`/api/designs/${id}/batch-weights/preview`, { moisture });
export const saveBatch = (id: string, moisture: MoistureRow[]) =>
  post<{ id: string; kind: string }>(`/api/designs/${id}/batch-instances`, { moisture });

/** The PDF is an audited export (POST); the browser saves it. */
export async function downloadSubmittal(id: string, code: string, lang: 'en' | 'ar' | 'both') {
  const res = await fetch(`/api/designs/${id}/submittal`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ lang }),
  });
  if (!res.ok) throw new ApiError(res.status, res.statusText);
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = `${code}-${lang}.pdf`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export interface PlanLineView {
  materialId: string;
  category: string;
  designKgPerM3: number;
  correctedKgPerM3: number;
  exactKg: number;
  resolutionKg: number;
  roundedKg: number;
  errorKg: number;
  deviationPct: number;
}
export interface PlanBlockerView {
  code: string;
  subject: string;
  detail: string;
}
export type PlanView =
  | {
      ok: true;
      batchSizeM3: number;
      lines: PlanLineView[];
      reconciliation: {
        designTotalKg: number;
        exactTotalKg: number;
        roundedTotalKg: number;
        roundedMinusExactKg: number;
        maxLineDeviationPct: number;
      };
    }
  | { ok: false; blockers: PlanBlockerView[] };
export interface PlanPreview {
  conversion: { result: BatchResult; validator: { status: 'pass' | 'fail' } };
  plan: PlanView | null;
  planValidator: { status: 'pass' | 'fail' } | null;
  binding: { designVersionHash: string };
  design: { code: string; version: number };
}
export const previewPlan = (id: string, moisture: MoistureRow[], batchSizeM3: number) =>
  post<PlanPreview>(`/api/designs/${id}/batch-plans/preview`, { moisture, batchSizeM3 });
export const savePlan = (id: string, moisture: MoistureRow[], batchSizeM3: number) =>
  post<{ id: string; kind: string; designVersionHash: string }>(`/api/designs/${id}/batch-plans`, {
    moisture,
    batchSizeM3,
  });
