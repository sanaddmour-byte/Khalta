import { queryOptions } from '@tanstack/react-query';
import { api } from '../lib/api';

export type InsightType =
  | 'opportunity'
  | 'test_expired'
  | 'prices_stale'
  | 'test_drift'
  | 'rule_change'
  | 'low_strength'
  | 'compliance_failure'
  | 'model_invalidated';
export type Severity = 'info' | 'medium' | 'high' | 'critical';

export interface Insight {
  id: string;
  type: InsightType;
  severity: Severity;
  status: 'open' | 'snoozed' | 'dismissed' | 'accepted' | 'expired';
  plantId: string | null;
  designId: string | null;
  payload: Record<string, unknown>;
  savingJodPerM3: string | null;
  annualJod: string | null;
  theoretical: boolean;
  provisional: boolean;
  snoozedUntil: string | null;
  draftDesignId: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  ownership: {
    state: 'unassigned' | 'assigned' | 'acknowledged' | 'overdue' | 'escalated';
    ownerId: string | null;
    ownerName: string | null;
    dueAt: string | null;
    acknowledgedAt: string | null;
    escalatedAt: string | null;
  } | null;
}
export interface Assignee {
  id: string;
  name: string;
  role: string;
}
export const assigneesQuery = (id: string) =>
  queryOptions({
    queryKey: ['insights', 'assignees', id],
    queryFn: () => api<Assignee[]>(`/api/insights/${id}/assignees`),
  });
export const assignInsight = (id: string, ownerId: string) =>
  api<{ id: string }>(`/api/insights/${id}/assign`, {
    method: 'POST',
    body: JSON.stringify({ ownerId }),
  });
export const acknowledgeInsight = (id: string) =>
  api<{ id: string }>(`/api/insights/${id}/acknowledge`, { method: 'POST', body: '{}' });
export interface Digest {
  day: string;
  summary: {
    open: number;
    new24h: number;
    bySeverity: Record<string, number>;
    byType: Record<string, number>;
    topOpportunities: {
      id: string;
      designId: string;
      savingJodPerM3: string | null;
      annualJod: string | null;
    }[];
  };
}
export interface Volumes {
  inForce: { month: string; volumeM3: string }[];
  history: {
    id: string;
    month: string;
    volumeM3: string;
    note: string | null;
    createdAt: string;
    actor: string | null;
  }[];
}

const post = <T>(path: string, body?: unknown) =>
  api<T>(path, { method: 'POST', body: JSON.stringify(body ?? {}) });

export const insightsQuery = (severity?: Severity) =>
  queryOptions({
    queryKey: ['insights', 'list', severity ?? 'all'],
    queryFn: () => api<Insight[]>(`/api/insights${severity ? `?severity=${severity}` : ''}`),
    refetchInterval: 60_000,
  });
export const digestQuery = queryOptions({
  queryKey: ['insights', 'digest'],
  queryFn: () => api<Digest | null>('/api/insights/digest'),
});
export const volumesQuery = (designId: string) =>
  queryOptions({
    queryKey: ['volumes', designId],
    queryFn: () => api<Volumes>(`/api/production-volumes?designId=${designId}`),
  });

export const dismissInsight = (id: string, reason: string) =>
  post(`/api/insights/${id}/dismiss`, { reason });
export const snoozeInsight = (id: string, days: 1 | 7) =>
  post(`/api/insights/${id}/snooze`, { days });
export const acceptInsight = (id: string) =>
  post<{ id: string; design: { id: string; code: string; version: number } }>(
    `/api/insights/${id}/accept`,
  );
export const recordVolume = (body: {
  designId: string;
  month: string;
  volumeM3: number;
  note?: string;
}) => post('/api/production-volumes', body);
