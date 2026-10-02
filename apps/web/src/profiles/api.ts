import { queryOptions } from '@tanstack/react-query';
import { api } from '../lib/api';

export type Scope = 'tenant' | 'plant' | 'product_family';
export interface AppliesTo {
  fcMin?: number;
  fcMax?: number;
  exposure?: string[];
  pumpable?: boolean;
  placement?: string;
  season?: string;
}
export interface VersionSummary {
  version: number;
  status: 'draft' | 'approved';
  createdAt: string;
  approvedAt: string | null;
  approvedBy: string | null;
  createdBy: string | null;
  changeNote: string | null;
}
export interface ProfileRow {
  id: string;
  scope: Scope;
  plantId: string | null;
  nameAr: string;
  nameEn: string;
  family: string | null;
  latest: VersionSummary;
  approved: VersionSummary | null;
  appliesTo: AppliesTo;
  checkOk: boolean | null;
}
export interface ExposureCheck {
  exposure: string;
  mode: 'ACI' | 'JS';
  ok: boolean;
  rejected: {
    key?: string;
    message?: string;
    proposed?: unknown;
    allowed?: unknown;
    rule?: string | null;
    clause?: string | null;
  }[];
}
export interface VersionDetail extends VersionSummary {
  appliesTo: AppliesTo;
  characteristics: Record<string, unknown>;
  materials: { include?: string[]; exclude?: string[]; prefer?: string[] };
  objective: 'cheapest' | 'closest_to_targets' | null;
  mode: 'ACI' | 'JS' | 'BOTH' | null;
  check: { ok?: boolean; results?: ExposureCheck[] };
}
export interface ProfileDetail {
  id: string;
  scope: Scope;
  plantId: string | null;
  nameAr: string;
  nameEn: string;
  family: string | null;
  versions: VersionDetail[];
}
export interface DiffRow {
  key: string;
  kind: 'added' | 'removed' | 'changed';
  from: unknown;
  to: unknown;
}
export interface Usage {
  designs: {
    id: string;
    code: string;
    designVersion: number;
    status: string;
    profileVersion: number;
  }[];
  requests: number;
  olderDesigns: { id: string; code: string; profileVersion: number }[];
}
export interface Brief {
  profileId: string;
  version: number;
  status: 'draft' | 'approved';
  scope: Scope;
  name: string;
  family: string | null;
  specificity: number;
  origin: string;
}
export interface MatchResult {
  chosen: Brief[];
  alsoMatched: Brief[];
  ties: { scope: Scope; candidates: Brief[] }[];
  defaults: {
    objective: 'cheapest' | 'closest_to_targets' | null;
    mode: 'ACI' | 'JS' | 'BOTH' | null;
  };
  materials: { include?: string[]; exclude?: string[]; prefer?: string[] };
  ok: boolean;
  rejected: unknown[];
  characteristics: {
    id: string;
    key: string;
    sub: string | null;
    spec: Record<string, unknown>;
    origin: string;
  }[];
  hasDraft: boolean;
}
export interface MatchBody {
  plantId: string;
  fcMpa: number | null;
  exposure: string[];
  pumpable: boolean | null;
  placement?: string | null;
  season?: string | null;
  profileIds?: string[];
  characteristics?: unknown;
  mode: 'ACI' | 'JS' | 'BOTH';
}
export interface ContentBody {
  appliesTo: AppliesTo;
  characteristics: Record<string, unknown>;
  materials: { include?: string[]; exclude?: string[]; prefer?: string[] };
  objective: 'cheapest' | 'closest_to_targets' | null;
  mode: 'ACI' | 'JS' | 'BOTH' | null;
  changeNote?: string;
}
export interface CreateBody extends ContentBody {
  scope: Scope;
  plantId: string | null;
  nameAr: string;
  nameEn: string;
  family: string | null;
}

const post = <T>(path: string, body?: unknown) =>
  api<T>(path, { method: 'POST', body: JSON.stringify(body ?? {}) });

export const profilesQuery = (scope?: string, plantId?: string) =>
  queryOptions({
    queryKey: ['profiles', scope ?? 'all', plantId ?? 'all'],
    queryFn: () => {
      const qs = new URLSearchParams();
      if (scope) qs.set('scope', scope);
      if (plantId) qs.set('plantId', plantId);
      return api<ProfileRow[]>(`/api/profiles${qs.size ? `?${qs}` : ''}`);
    },
  });
export const profileQuery = (id: string) =>
  queryOptions({
    queryKey: ['profile', id],
    queryFn: () => api<ProfileDetail>(`/api/profiles/${id}`),
  });
export const diffQuery = (id: string, from: number, to: number) =>
  queryOptions({
    queryKey: ['profile-diff', id, from, to],
    queryFn: () => api<{ rows: DiffRow[] }>(`/api/profiles/${id}/diff?from=${from}&to=${to}`),
  });
export const usageQuery = (id: string) =>
  queryOptions({
    queryKey: ['profile-usage', id],
    queryFn: () => api<Usage>(`/api/profiles/${id}/usage`),
  });

export const matchProfiles = (body: MatchBody) => post<MatchResult>('/api/profiles/match', body);
export const createProfile = (body: CreateBody) =>
  post<{
    id: string;
    version: number;
    status: string;
    check: { ok: boolean; results: ExposureCheck[] };
  }>('/api/profiles', body);
export const createVersion = (id: string, body: ContentBody) =>
  post<{
    id: string;
    version: number;
    status: string;
    check: { ok: boolean; results: ExposureCheck[] };
  }>(`/api/profiles/${id}/versions`, body);
export const approveVersion = (id: string, v: number) =>
  post<{ status: string }>(`/api/profiles/${id}/versions/${v}/approve`);

/** `profile:<id>@<n>` → readable label via a name lookup; `request` stays `request`. */
export const parseOrigin = (o: string): { profileId: string; version: number } | null => {
  const m = /^profile:([0-9a-f-]{36})@(\d+)$/.exec(o);
  return m ? { profileId: m[1]!, version: Number(m[2]) } : null;
};
