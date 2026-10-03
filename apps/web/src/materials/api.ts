import type { Category, Properties, Source } from '@khalta/engine';
import { queryOptions } from '@tanstack/react-query';
import { api, ApiError } from '../lib/api';

export interface Freshness {
  status: 'fresh' | 'expired' | 'not_configured';
  ageDays: number;
  validUntil?: string;
}
export interface Blocker {
  field: string;
  workflow: 'evaluate' | 'design';
  code: 'missing' | 'invalid';
  detail?: string;
}
export interface DriftItem {
  field: string;
  previous: number;
  current: number;
  delta: number;
  tolerance: number | null;
  status: 'within' | 'beyond' | 'no_tolerance';
}
export interface Summary {
  hasTest: boolean;
  canEvaluate: boolean;
  canDesign: boolean;
  evaluateBlockers?: Blocker[];
  designBlockers?: Blocker[];
  fm?: number | null;
  fmMissing?: number[];
  source?: Source;
  declaredKeyFields?: string[];
  freshness?: Freshness;
  drift?: DriftItem[];
}
export interface Material {
  id: string;
  category: Category;
  plantId: string | null;
  supplierId: string | null;
  marketNameAr: string | null;
  marketNameEn: string;
  technicalName: string | null;
  sourceName: string | null;
  notes: string | null;
  isActive: boolean;
  promotedFrom: string | null;
}
export interface MaterialRow extends Material {
  testedAt: string | null;
  version: number | null;
  source: Source | null;
  hasTest: boolean;
  canEvaluate: boolean;
  canDesign: boolean;
  fm: number | null;
  freshness: Freshness | null;
  declaredKeyFields: string[];
  /** Cement only: the recorded market label (absent for other categories). */
  cementKind?: string | null;
  cementClass?: number | null;
}
export interface AttachmentMeta {
  filename: string;
  contentType: string;
  sizeBytes: number;
}
export interface MaterialTest {
  id: string;
  version: number;
  isCurrent: boolean;
  source: Source;
  fieldSources: Record<string, Source>;
  properties: Properties;
  testedAt: string;
  validUntil: string | null;
  labRef: string | null;
  attachmentId: string | null;
  attachment: AttachmentMeta | null;
  declaredReason: string | null;
  declaredBy: string | null;
  declaredAt: string | null;
  changeReason: string | null;
  createdAt: string;
}
export interface MaterialDetail {
  material: Material;
  current: MaterialTest | null;
  summary: Summary;
  versions: number;
}
export interface Supplier {
  id: string;
  nameAr: string;
  nameEn: string;
  contact: string | null;
  phone: string | null;
  email: string | null;
  city: string | null;
  isActive: boolean;
}
export interface SanityWarning {
  field: string;
  value: number;
  range: { min?: number; max?: number };
}
export interface TestResult {
  test: MaterialTest;
  warnings: SanityWarning[];
  summary: Summary;
}

export const materialsQuery = (params: Record<string, string | undefined> = {}) => {
  const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v) as [string, string][]);
  return queryOptions({
    queryKey: ['materials', 'list', qs.toString()],
    queryFn: () => api<MaterialRow[]>(`/api/materials${qs.size ? `?${qs}` : ''}`),
    staleTime: 10_000,
  });
};
export const materialQuery = (id: string) =>
  queryOptions({
    queryKey: ['materials', 'one', id],
    queryFn: () => api<MaterialDetail>(`/api/materials/${id}`),
  });
export const testsQuery = (id: string) =>
  queryOptions({
    queryKey: ['materials', 'tests', id],
    queryFn: () => api<MaterialTest[]>(`/api/materials/${id}/tests`),
  });
export const suppliersQuery = queryOptions({
  queryKey: ['suppliers'],
  queryFn: () => api<Supplier[]>('/api/suppliers'),
  staleTime: 30_000,
});

export interface TestBody {
  properties: Properties;
  source: Source;
  fieldSources?: Record<string, Source>;
  testedAt: string;
  labRef?: string;
  attachmentId?: string;
  declaredReason?: string;
  changeReason?: string;
}
export interface NewMaterialBody {
  category: Category;
  marketNameEn: string;
  marketNameAr?: string | null;
  technicalName?: string | null;
  sourceName?: string | null;
  plantId?: string | null;
  supplierId?: string | null;
}

export const createMaterial = (body: NewMaterialBody) =>
  api<Material>('/api/materials', { method: 'POST', body: JSON.stringify(body) });
export const addTest = (id: string, body: TestBody) =>
  api<TestResult>(`/api/materials/${id}/tests`, { method: 'POST', body: JSON.stringify(body) });
export const createSupplier = (body: { nameEn: string; nameAr: string }) =>
  api<Supplier>('/api/suppliers', { method: 'POST', body: JSON.stringify(body) });

export async function uploadAttachment(file: File) {
  const res = await fetch(`/api/attachments?filename=${encodeURIComponent(file.name)}`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/octet-stream' },
    body: file,
  });
  if (!res.ok) {
    let message = res.statusText;
    try {
      message = (await res.json())?.error?.message ?? message;
    } catch {
      /* non-JSON error */
    }
    throw new ApiError(res.status, message);
  }
  return (await res.json()) as { id: string } & AttachmentMeta;
}

/** Opens a stored evidence file in a new tab via an authorized fetch (never a public URL). */
export async function openAttachment(id: string) {
  const res = await fetch(`/api/attachments/${id}`, { credentials: 'same-origin' });
  if (!res.ok) throw new ApiError(res.status, res.statusText);
  const url = URL.createObjectURL(await res.blob());
  window.open(url, '_blank', 'noopener');
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export interface MaterialParams {
  fmSieves: number[];
  testAgeLimitDays: Record<string, number | null>;
  driftTolerance: Record<string, number | null>;
}
export const paramsQuery = queryOptions({
  queryKey: ['materials', 'params'],
  queryFn: () => api<MaterialParams>('/api/materials/params'),
  staleTime: 60_000,
});
