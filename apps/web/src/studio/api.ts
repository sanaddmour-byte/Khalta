import type {
  CandidateGuardrails,
  CharacteristicRow,
  EvaluationReport,
  EvidenceStatus,
  ValidatorResult,
} from '@khalta/engine';
import { queryOptions } from '@tanstack/react-query';
import { api } from '../lib/api';

export type Mode = 'ACI' | 'JS' | 'BOTH';
export type Objective = 'cheapest' | 'closest_to_targets';

export interface Requirements {
  fcMpa: number;
  basis: 'cylinder' | 'cube' | 'b_grade';
  testAgeDays: number;
  exposure: string[];
  slumpMm: number;
  nmasMm: number | null;
  pumpable: boolean;
  s3Option: 1 | 2 | null;
  airPct: number | null;
}
export interface AdHocMaterial {
  category: 'cement' | 'scm' | 'fine_agg' | 'coarse_agg' | 'admixture' | 'water';
  market_name_en: string;
  market_name_ar?: string;
  properties: Record<string, unknown>;
  price_jod_per_kg?: string;
}
export interface RequestBody {
  plantId: string;
  mode: Mode;
  objective: Objective;
  requirements: Requirements;
  characteristics?: Record<string, unknown>;
  materials?: { include?: string[]; exclude?: string[] };
  adHoc?: AdHocMaterial[];
  profileIds?: string[];
  cementColour?: 'any' | 'white' | 'grey';
}

export interface PoolMaterial {
  id: string;
  category: string;
  nameEn: string;
  nameAr: string | null;
  usable: boolean;
  reason: string | null;
  hasTest: boolean;
  source: string | null;
  cementKind?: string | null;
  cementClass?: number | null;
}
export interface Bound {
  requirement: string;
  value: unknown;
  status: 'resolved' | 'provisional' | 'blocked';
  source: string | null;
  clause: string | null;
  verified: boolean;
}
export interface Blocker {
  code: string;
  subject: string;
  detail: string;
}
export interface Rejected {
  key: string;
  code: string;
  message: string;
  proposed: unknown;
  allowed: unknown;
  rule: string | null;
  clause: string | null;
  source: string | null;
}
export interface Preflight {
  pool: PoolMaterial[];
  bounds: Bound[];
  fcrMpa: number | null;
  blockers: Blocker[];
  baseline: { wc: number; wcmCeiling: number; waterKg: Record<string, number> } | null;
  characteristics: {
    ok: boolean;
    invalid: { key?: string; message: string }[];
    rejected: Rejected[];
  };
}

export interface Margins {
  wcmHeadroom: number;
  wcmCeiling: number;
  cfMargin: number;
  wfMargin: number;
  finesMargin: number;
  gradingMarginPts: number;
}
export interface Candidate {
  id: string;
  rank: number;
  configuration: {
    cementId: string;
    scmId: string | null;
    scmPct: number;
    admixtureId: string | null;
    dosagePct: number;
    nmasMm: number;
    airPct: number;
  };
  lines: { materialId: string; kgPerM3: string }[];
  report: EvaluationReport;
  guardrails: CandidateGuardrails;
  margins: Margins;
  binding: { id: string; shadowPrice: number; klass: string }[];
  characteristics: CharacteristicRow[];
  deviations: { key: string; requested: number; achieved: number; weightedCostJod?: number }[];
  notes: { code: string; detail: string }[];
  evidence: EvidenceStatus[];
  requiresAuthorization: boolean;
  costJodPerM3: string | null;
  validator: { status: 'pass' | 'fail'; version: string | null; checked: unknown };
  design?: { id: string; code: string; status: string } | null;
}
export interface Dof {
  quantities: number;
  equalities: number;
  dof: number;
  state: 'free' | 'fully_specified' | 'over_specified';
  fixed: string[];
}
export interface Conflict {
  id: string;
  klass: string;
  relaxBy: number | null;
  unit: string;
  detail: string;
  /** Who owns the limit; only a user preference is adjustable. */
  category?: string;
  adjustable?: boolean;
}
export interface Outcome {
  blockers: Blocker[];
  conflicts: { kind: 'user_specified' | 'hard_rows'; items: Conflict[] } | null;
  dof: Dof | null;
  stats: { enumerated: number; solved: number; truncated: boolean; elapsedMs: number };
  excluded: { materialId: string; reason: string }[];
  notes: { code: string; detail: string }[];
}
export interface GenerateResult {
  id: string;
  status: 'candidates' | 'blocked' | 'infeasible' | 'no_valid_candidate';
  objective: Objective;
  outcome: Outcome;
  candidates: Candidate[];
}
export interface RequestListRow {
  id: string;
  plantId: string;
  mode: Mode;
  objective: Objective;
  status: GenerateResult['status'];
  createdAt: string;
  candidates: number;
}
export interface MixEvaluation {
  report: EvaluationReport;
  validator: ValidatorResult;
}
export interface CompareResult {
  plantId: string;
  status: string;
  requestId: string | null;
  reason: string | null;
  best: { costJodPerM3: string | null; candidates: number } | null;
}

const post = <T>(path: string, body: unknown) =>
  api<T>(path, { method: 'POST', body: JSON.stringify(body) });

export const preflight = (body: Omit<RequestBody, 'objective'> & { objective?: Objective }) =>
  post<Preflight>('/api/design-requests/preflight', body);
export const generate = (body: RequestBody) => post<GenerateResult>('/api/design-requests', body);
export const evaluateMix = (
  body: Omit<RequestBody, 'objective'> & { lines: { materialId: string; kgPerM3: string }[] },
) => post<MixEvaluation>('/api/design-requests/evaluate-mix', body);
export const saveDraft = (
  body: Omit<RequestBody, 'objective'> & {
    code: string;
    name: string;
    lines: { materialId: string; kgPerM3: string }[];
  },
) => post<{ id: string; code: string; status: string }>('/api/designs', body);
export const requestTrial = (
  requestId: string,
  candidateId: string,
  body: { code: string; name: string; authorizationReason?: string },
) =>
  post<{ design: { id: string; code: string; status: string } }>(
    `/api/design-requests/${requestId}/candidates/${candidateId}/trial-candidate`,
    body,
  );
export const comparePlants = (
  body: Omit<RequestBody, 'plantId'> & {
    plants: { plantId: string; mapping: Record<string, string | null> }[];
  },
) => post<{ results: CompareResult[] }>('/api/design-requests/compare-plants', body);

export const requestsQuery = (plantId?: string) =>
  queryOptions({
    queryKey: ['design-requests', plantId ?? 'all'],
    queryFn: () =>
      api<RequestListRow[]>(`/api/design-requests${plantId ? `?plantId=${plantId}` : ''}`),
  });
export const requestQuery = (id: string) =>
  queryOptions({
    queryKey: ['design-request', id],
    queryFn: () =>
      api<GenerateResult & { plantId: string; request: Requirements; inputs: unknown; mode: Mode }>(
        `/api/design-requests/${id}`,
      ),
  });
