import { queryOptions } from '@tanstack/react-query';
import type { Role } from '@khalta/rbac';
import { api } from '../lib/api';

export interface AdminPlant {
  id: string;
  code: string;
  nameAr: string;
  nameEn: string;
  city: string | null;
  region: string | null;
  isActive: boolean;
  ambientProfile: 'hot' | 'moderate';
  haulCostJodPerM3Km: string | null;
}
export interface AdminUser {
  id: string;
  name: string;
  email: string;
  role: Role;
  plantIds: string[];
}
export interface TenantSettings {
  maxPlants: number;
  salesCanViewCost: boolean;
  numberFormat: 'latin' | 'arabic-indic';
  stalePriceDays: number | null;
  nearLimitPct: number | null;
  safetyMarginMpa: number | null;
  yieldTolerance: number;
  insightMinSavingJodPerM3: number;
  insightMinAnnualJod: number;
  sanityRanges: Record<string, { min?: number; max?: number }>;
  approvalRequiresLabSource: boolean;
}

export const adminPlantsQuery = queryOptions({
  queryKey: ['plants'],
  queryFn: () => api<AdminPlant[]>('/api/plants'),
});
export const usersQuery = queryOptions({
  queryKey: ['users'],
  queryFn: () => api<AdminUser[]>('/api/users'),
});
export const settingsQuery = queryOptions({
  queryKey: ['settings'],
  queryFn: () => api<TenantSettings>('/api/settings'),
});

const json = (method: string, body?: unknown): RequestInit => ({
  method,
  ...(body !== undefined && { body: JSON.stringify(body) }),
});
export const savePlant = (id: string | null, body: Partial<Omit<AdminPlant, 'id'>>) =>
  api<AdminPlant>(id ? `/api/plants/${id}` : '/api/plants', json(id ? 'PATCH' : 'POST', body));
export const saveSettings = (body: Partial<TenantSettings>) =>
  api<TenantSettings>('/api/settings', json('PATCH', body));
export const createUser = (body: { email: string; name: string; role: Role; password: string }) =>
  api<AdminUser>('/api/users', json('POST', body));
export const updateUser = (id: string, body: { name?: string; role?: Role }) =>
  api<AdminUser>(`/api/users/${id}`, json('PATCH', body));
export const deactivateUser = (id: string) => api(`/api/users/${id}`, json('DELETE'));
export const resetPassword = (id: string, password: string) =>
  api(`/api/users/${id}/password`, json('POST', { password }));
export const setUserPlants = (id: string, plantIds: string[]) =>
  api(`/api/users/${id}/plants`, json('PUT', { plantIds }));
