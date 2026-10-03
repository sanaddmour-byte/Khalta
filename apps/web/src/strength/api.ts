import { queryOptions } from '@tanstack/react-query';
import { api } from '../lib/api';

export interface Held {
  method: string;
  n: number;
  rmseMpa: number;
  meanErrorMpa: number;
  worstMissMpa: number;
  coverage: number;
}
export interface ModelGroup {
  plantId: string;
  cementId: string;
  cementType: string | null;
  scm: { id: string; type: string | null }[];
  admixtures: { id: string; type: string | null }[];
  basis: 'cylinder' | 'cube';
  ageDays: number;
}
export interface StrengthModel {
  id: string;
  plantId: string;
  groupKey: string;
  group: ModelGroup;
  ageDays: number;
  basis: 'cylinder' | 'cube';
  a: string;
  b: string;
  seA: string;
  seB: string;
  n: number;
  levels: number;
  wcmMin: string;
  wcmMax: string;
  sMpa: string;
  r2: string;
  heldOut: Held | null;
  reasons: { code: string; detail: string }[];
  status: 'valid' | 'provisional' | 'invalidated';
  fittedAt: string;
  approvedAt: string | null;
  retiredAt: string | null;
  retiredReason: string | null;
  inForce: boolean;
}
export interface ModelList {
  models: StrengthModel[];
  unassigned: { designId: string; plantId: string; reason: string; sets: number }[];
  materials: Record<string, { nameEn: string; nameAr: string | null }>;
}
export interface ModelDetail {
  model: StrengthModel;
  points: {
    id: string;
    resultId: string;
    wcm: string | null;
    mpa: string;
    included: boolean;
    exclusion: string | null;
  }[];
}
export interface SProposal {
  designId: string;
  code: string;
  version: number;
  plantId: string;
  n: number;
  sMpa: number | null;
  meanMpa: number | null;
  enoughForCode: boolean;
  higherThanModel: boolean;
  note: string;
}
export interface BetaResult {
  proposal: {
    ok: boolean;
    n: number;
    missing: { code: string; detail: string }[];
    betaFm: number | null;
    betaP75: number | null;
    seBetaFm: number | null;
    seBetaP75: number | null;
  };
  skipped: { batchId: string; reason: string }[];
}

const post = <T>(path: string, body?: unknown) =>
  api<T>(path, { method: 'POST', body: JSON.stringify(body ?? {}) });

export const modelsQuery = (plantId?: string) =>
  queryOptions({
    queryKey: ['strength', 'models', plantId ?? ''],
    queryFn: () => api<ModelList>(`/api/strength-models${plantId ? `?plantId=${plantId}` : ''}`),
  });
export const modelQuery = (id: string) =>
  queryOptions({
    queryKey: ['strength', 'model', id],
    queryFn: () => api<ModelDetail>(`/api/strength-models/${id}`),
  });
export const sProposalQuery = (plantId?: string) =>
  queryOptions({
    queryKey: ['strength', 's', plantId ?? ''],
    queryFn: () =>
      api<{ proposals: SProposal[] }>(
        `/api/strength/s-proposal${plantId ? `?plantId=${plantId}` : ''}`,
      ),
  });
export const betaQuery = (plantId: string) =>
  queryOptions({
    queryKey: ['strength', 'beta', plantId],
    queryFn: () => api<BetaResult>(`/api/strength/beta-proposal?plantId=${plantId}`),
  });

export const refit = (plantId?: string) =>
  post<{ groups: { result: string; status?: string }[] }>(
    '/api/strength-models/refit',
    plantId ? { plantId } : {},
  );
export const approveModel = (id: string, reason: string) =>
  post(`/api/strength-models/${id}/approve`, { reason });
export const retireModel = (id: string, reason: string) =>
  post(`/api/strength-models/${id}/retire`, { reason });
