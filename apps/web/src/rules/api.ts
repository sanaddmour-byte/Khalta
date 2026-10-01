import { queryOptions } from '@tanstack/react-query';
import { api } from '../lib/api';

export type RuleStatus = 'verified' | 'unverified' | 'missing' | 'info';

export interface TableDefinition {
  rows?: { name: string; values: (number | [number, number])[] };
  cols: { name: string; values: number[] };
  data: (number | null)[][];
  interpolation: 'linear' | 'none';
}

export interface Rule {
  id: string;
  ruleset: string;
  key: string;
  requirement: string;
  kind: string;
  requirementClass: string;
  group: string | null;
  appliesTo: Record<string, unknown>;
  prerequisites: string[];
  value: unknown;
  definition: TableDefinition | null;
  inherits: string | null;
  units: string;
  clauseRef: string;
  noteEn: string | null;
  noteAr: string | null;
  verified: boolean;
  verifiedAt: string | null;
  version: number;
  origin: string;
  changeReason: string | null;
  status: RuleStatus;
  usedByDesigns: number;
}

export interface RulesResponse {
  rules: Rule[];
  summary: {
    byRuleset: Record<
      string,
      { total: number; verified: number; unverified: number; missing: number }
    >;
  };
}

export interface RuleDetail {
  rule: Rule;
  versions: {
    id: string;
    version: number;
    isCurrent: boolean;
    origin: string;
    createdAt: string;
    createdByName: string | null;
    changeReason: string | null;
    verified: boolean;
    value: unknown;
    clauseRef: string;
  }[];
  verifications: { id: string; ruleId: string; note: string; at: string; by: string }[];
}

export interface ImportRow {
  line: number;
  ruleKey: string;
  status: 'ok' | 'unchanged' | 'error';
  errors: string[];
  current?: { value: unknown; clauseRef: string };
  proposed?: { value?: unknown; inherits?: string | null; clauseRef: string };
}
export interface ImportPreview {
  batchId: string;
  rows: ImportRow[];
  summary: { total: number; ok: number; unchanged: number; errors: number };
  fileErrors: string[];
}

export const rulesQuery = queryOptions({
  queryKey: ['rules'],
  queryFn: () => api<RulesResponse>('/api/rules'),
  staleTime: 15_000,
});
export const ruleDetailQuery = (id: string) =>
  queryOptions({ queryKey: ['rules', id], queryFn: () => api<RuleDetail>(`/api/rules/${id}`) });

export const verifyRule = (id: string, note: string) =>
  api(`/api/rules/${id}/verify`, { method: 'POST', body: JSON.stringify({ note }) });
export const editRule = (
  id: string,
  body: {
    value?: unknown;
    definition?: TableDefinition | null;
    clause_ref?: string;
    reason: string;
  },
) => api<Rule>(`/api/rules/${id}/value`, { method: 'PATCH', body: JSON.stringify(body) });
export const previewImport = (csv: string, filename?: string) =>
  api<ImportPreview>('/api/rules/import/preview', {
    method: 'POST',
    body: JSON.stringify({ csv, filename }),
  });
export const commitImport = (batchId: string) =>
  api<{ applied: number }>('/api/rules/import/commit', {
    method: 'POST',
    body: JSON.stringify({ batchId }),
  });
