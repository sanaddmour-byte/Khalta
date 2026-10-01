import type { PriceUnit } from '@khalta/engine';
import { queryOptions } from '@tanstack/react-query';
import { api, ApiError } from '../lib/api';

export interface MatrixCell {
  materialId: string;
  plantId: string;
  status: 'ok' | 'ambiguous';
  id?: string;
  supplierId?: string;
  supplierIds?: string[];
  price?: string;
  unit?: PriceUnit;
  includesDelivery?: boolean;
  effectiveFrom?: string;
  alternatives?: number;
  jodPerKg?: string | null;
  notConvertible?: 'needs_density' | 'needs_sg' | 'invalid_price';
  staleness?: { status: 'fresh' | 'stale' | 'not_configured'; ageDays: number };
}
export interface MatrixMaterial {
  id: string;
  category: string;
  marketNameAr: string | null;
  marketNameEn: string;
  supplierId: string | null;
  plantId: string | null;
}
export interface MatrixPlant {
  id: string;
  code: string;
  nameAr: string;
  nameEn: string;
}
export interface MatrixSupplier {
  id: string;
  nameAr: string;
  nameEn: string;
}
export interface Matrix {
  asOf: string;
  plants: MatrixPlant[];
  suppliers: MatrixSupplier[];
  materials: MatrixMaterial[];
  cells: MatrixCell[];
  summary: {
    pairs: number;
    priced: number;
    unpriced: number;
    ambiguous: number;
    stale: number;
    notConvertible: number;
    staleLimitDays: number | null;
  };
}
export interface HistoryRow {
  id: string;
  supplierId: string;
  price: string;
  unit: PriceUnit;
  includesDelivery: boolean;
  effectiveFrom: string;
  effectiveTo: string | null;
  supersededAt: string | null;
  reason: string | null;
  createdAt: string;
  enteredBy: string | null;
}
export interface Snapshot {
  id: string;
  name: string;
  asOf: string;
  lineCount: number;
  contentHash: string;
  createdAt: string;
}
export interface ImportRow {
  line: number;
  status: 'ok' | 'unchanged' | 'error';
  errors: string[];
  entry?: {
    materialId: string;
    plantId: string;
    price: string;
    unit: PriceUnit;
    effectiveFrom?: string;
  };
}
export interface ImportPreview {
  batchId: string;
  summary: { total: number; ok: number; unchanged: number; errors: number };
  rows: ImportRow[];
}
export interface SetEntry {
  materialId: string;
  plantId: string;
  supplierId?: string;
  price: string;
  unit: PriceUnit;
}

export const matrixQuery = (asOf?: string) =>
  queryOptions({
    queryKey: ['prices', 'matrix', asOf ?? 'today'],
    queryFn: () => api<Matrix>(`/api/prices${asOf ? `?asOf=${asOf}` : ''}`),
    staleTime: 10_000,
  });
export const historyQuery = (materialId: string, plantId: string) =>
  queryOptions({
    queryKey: ['prices', 'history', materialId, plantId],
    queryFn: () =>
      api<HistoryRow[]>(`/api/prices/history?materialId=${materialId}&plantId=${plantId}`),
  });
export const snapshotsQuery = queryOptions({
  queryKey: ['prices', 'snapshots'],
  queryFn: () => api<Snapshot[]>('/api/price-snapshots'),
});
export const coverageQuery = queryOptions({
  queryKey: ['prices', 'coverage'],
  queryFn: () => api<{ plants: number; priced: Record<string, number> }>('/api/prices/coverage'),
  staleTime: 30_000,
});

const post = <T>(path: string, body: unknown) =>
  api<T>(path, { method: 'POST', body: JSON.stringify(body) });
export const savePrices = (body: {
  entries: SetEntry[];
  effectiveFrom?: string;
  reason?: string;
}) => post<{ applied: number; unchanged: number }>('/api/prices', body);
export const setPreferred = (body: { materialId: string; plantId: string; supplierId: string }) =>
  post('/api/prices/preferred', body);
export interface BulkBody {
  percent: string;
  plantIds?: string[];
  effectiveFrom?: string;
  reason?: string;
}
export const bulkPreview = (body: BulkBody) =>
  post<{
    count: number;
    rows: { materialId: string; plantId: string; from?: string; to: string; unit: string }[];
  }>('/api/prices/bulk-change/preview', body);
export const bulkApply = (body: BulkBody) =>
  post<{ applied: number }>('/api/prices/bulk-change', body);
export const copyPrices = (body: {
  fromPlantId: string;
  toPlantId: string;
  overwrite?: boolean;
  effectiveFrom?: string;
  reason?: string;
}) => post<{ applied: number }>('/api/prices/copy', body);
export const commitImport = (batchId: string) =>
  post<{ applied: number; unchanged: number }>('/api/prices/import/commit', { batchId });
export const createSnapshot = (name: string) => post<Snapshot>('/api/price-snapshots', { name });

export async function previewImport(file: File): Promise<ImportPreview> {
  const res = await fetch(`/api/prices/import/preview?filename=${encodeURIComponent(file.name)}`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/octet-stream' },
    body: file,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, json?.error?.message ?? res.statusText);
  return json as ImportPreview;
}

/** Downloads a logged export through an authorized POST (never a public URL). */
export async function exportPrices(format: 'xlsx' | 'csv', asOf?: string) {
  const res = await fetch('/api/prices/export', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ format, ...(asOf && { asOf }) }),
  });
  if (!res.ok) throw new ApiError(res.status, res.statusText);
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = `prices.${format}`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
