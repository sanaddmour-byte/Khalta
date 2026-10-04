import { queryOptions } from '@tanstack/react-query';
import { api } from '../lib/api';

export interface DashCard {
  id: string;
  count: number;
  to: string;
  tone: 'neutral' | 'attention' | 'critical';
}
export interface Dashboard {
  role: string;
  cards: DashCard[];
  worklists: {
    awaitingApproval: { id: string; code: string; name: string }[];
    alerts: { id: string; type: string; severity: string; designCode: string | null }[];
  };
}
export const dashboardQuery = queryOptions({
  queryKey: ['dashboard'],
  queryFn: () => api<Dashboard>('/api/dashboard'),
});
