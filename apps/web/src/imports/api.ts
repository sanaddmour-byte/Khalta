import { api, ApiError } from '../lib/api';

export type Column =
  | 'design_code'
  | 'plant_code'
  | 'design_name'
  | 'fc_mpa'
  | 'strength_basis'
  | 'test_age_days'
  | 'exposure_classes'
  | 'slump_mm'
  | 'nmas_mm'
  | 'pumpable'
  | 'material_name'
  | 'material_category'
  | 'quantity'
  | 'unit'
  | 'approval_reference'
  | 'currently_in_production'
  | 'avg_monthly_volume_m3';
export const COLUMNS: Column[] = [
  'design_code',
  'plant_code',
  'design_name',
  'fc_mpa',
  'strength_basis',
  'test_age_days',
  'exposure_classes',
  'slump_mm',
  'nmas_mm',
  'pumpable',
  'material_name',
  'material_category',
  'quantity',
  'unit',
  'approval_reference',
  'currently_in_production',
  'avg_monthly_volume_m3',
];
export const REQUIRED: Column[] = [
  'design_code',
  'plant_code',
  'fc_mpa',
  'material_name',
  'material_category',
  'quantity',
  'unit',
];
export type Mapping = Partial<Record<Column, number>>;
export type Decision = { materialId: string } | { create: true } | null;
export type Decisions = Record<string, Decision>;
export interface Issue {
  code: string;
  line?: number;
  detail?: string;
}
export interface Upload {
  batchId: string;
  header: string[];
  lines: number;
  mapping: Mapping;
  missing: Column[];
}
export interface PlanMaterial {
  key: string;
  name: string;
  category: string;
  lines: number;
  exactId: string | null;
  ambiguous: boolean;
  suggestions: { id: string; name: string; category: string; score: number }[];
  decision: 'exact' | 'confirmed' | 'create' | 'unresolved';
  materialId: string | null;
}
export interface PlanDesign {
  code: string;
  name: string;
  plantCode: string;
  lines: {
    line: number;
    materialName: string;
    category: string;
    quantity: string;
    unit: string;
    kg: string | null;
  }[];
  errors: Issue[];
  warnings: Issue[];
}
export interface Plan {
  missing: Column[];
  fileErrors: string[];
  designs: PlanDesign[];
  materials: PlanMaterial[];
  summary: { designs: number; ok: number; errors: number; materials: number; unresolved: number };
}

export async function uploadLegacy(file: File): Promise<Upload> {
  const res = await fetch(`/api/imports/legacy/upload?filename=${encodeURIComponent(file.name)}`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/octet-stream' },
    body: file,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok)
    throw new ApiError(
      res.status,
      json?.error?.message ?? res.statusText,
      json?.error?.code,
      json?.error?.details,
    );
  return json as Upload;
}
const body = (mapping: Mapping, decisions: Decisions) => JSON.stringify({ mapping, decisions });
export const previewLegacy = (id: string, mapping: Mapping, decisions: Decisions) =>
  api<Plan>(`/api/imports/legacy/${id}/preview`, {
    method: 'POST',
    body: body(mapping, decisions),
  });
export const commitLegacy = (id: string, mapping: Mapping, decisions: Decisions) =>
  api<{ designs: number; createdMaterials: number }>(`/api/imports/legacy/${id}/commit`, {
    method: 'POST',
    body: body(mapping, decisions),
  });
