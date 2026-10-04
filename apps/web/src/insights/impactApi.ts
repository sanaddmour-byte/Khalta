import { queryOptions } from '@tanstack/react-query';
import { api } from '../lib/api';

export type ImpactClass =
  'no_action' | 'review' | 'revalidate' | 'requalify' | 'suspend_recommended';
export type ImpactDisposition =
  'revalidation_started' | 'requalification_required' | 'accepted_risk' | 'dismissed';
export interface ImpactItem {
  id: string;
  designId: string;
  designCode: string;
  designName: string;
  designVersion: number;
  plantCode: string;
  class: ImpactClass;
  reasons: string[];
  disposition: ImpactDisposition | null;
  dispositionAt: string | null;
  dispositionNote: string | null;
}
export interface Impact {
  id: string;
  trigger: string;
  subject: string;
  jobState: 'pending' | 'running' | 'failed' | 'completed';
  attempts: number;
  lastError: string | null;
  createdAt: string;
  items: ImpactItem[];
}
export const impactsQuery = () =>
  queryOptions({
    queryKey: ['change-impacts'],
    queryFn: () => api<Impact[]>('/api/change-impacts'),
  });
export const decide = (itemId: string, disposition: ImpactDisposition, reason: string) =>
  api<{ id: string }>(`/api/change-impacts/items/${itemId}/disposition`, {
    method: 'POST',
    body: JSON.stringify({ disposition, reason }),
  });
