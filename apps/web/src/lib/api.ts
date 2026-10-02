import type { Capability, PlantScope, Role } from '@khalta/rbac';
import { queryOptions } from '@tanstack/react-query';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    credentials: 'same-origin',
    ...init,
    headers: { ...(init.body ? { 'content-type': 'application/json' } : {}), ...init.headers },
  });
  if (!res.ok) {
    let message = res.statusText;
    let code: string | undefined;
    let details: unknown;
    try {
      const body = (await res.json())?.error;
      message = body?.message ?? message;
      code = body?.code;
      details = body?.details;
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(res.status, message, code, details);
  }
  return (res.status === 204 ? undefined : await res.json()) as T;
}

export interface Me {
  user: { id: string; name: string; email: string };
  role: Role;
  capabilities: Capability[];
  scope: PlantScope;
  instance: { demo: boolean };
  settings: {
    numberFormat: 'latin' | 'arabic-indic';
    sanityRanges: Record<string, { min?: number; max?: number }>;
  };
}
export interface Plant {
  id: string;
  code: string;
  nameAr: string;
  nameEn: string;
}

export const meQuery = queryOptions({
  queryKey: ['me'],
  queryFn: () => api<Me>('/api/me'),
  staleTime: 30_000,
  retry: false,
});
export const plantsQuery = queryOptions({
  queryKey: ['plants'],
  queryFn: () => api<Plant[]>('/api/plants'),
  staleTime: 30_000,
});

export const signIn = (email: string, password: string) =>
  api('/api/auth/sign-in/email', { method: 'POST', body: JSON.stringify({ email, password }) });
export const signOut = () => api('/api/auth/sign-out', { method: 'POST', body: '{}' });
