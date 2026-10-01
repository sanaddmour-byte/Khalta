import { useQuery } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { plantsQuery, type Plant } from './api';

export const ALL = 'all';

interface PlantCtx {
  plants: Plant[];
  /** Selected plant id, or `ALL` (unscoped roles only). */
  selected: string;
  select: (id: string) => void;
  loading: boolean;
}
const Ctx = createContext<PlantCtx | null>(null);
export const usePlant = () => {
  const v = useContext(Ctx);
  if (!v) throw new Error('usePlant outside PlantProvider');
  return v;
};

const KEY = 'khalta.plant';
const read = () => {
  try {
    return window.localStorage.getItem(KEY);
  } catch {
    return null;
  }
};

/** Global plant context (03-ui.md §2.7). Falls back to a valid plant if the saved one is gone. */
export function PlantProvider({ unscoped, children }: { unscoped: boolean; children: ReactNode }) {
  const { data, isLoading } = useQuery(plantsQuery);
  const plants = useMemo(() => data ?? [], [data]);
  const [saved, setSaved] = useState<string | null>(read);

  const selected = useMemo(() => {
    if (saved === ALL && unscoped) return ALL;
    if (saved && plants.some((p) => p.id === saved)) return saved;
    return unscoped ? ALL : (plants[0]?.id ?? '');
  }, [saved, plants, unscoped]);

  const select = useCallback((id: string) => {
    setSaved(id);
    try {
      window.localStorage.setItem(KEY, id);
    } catch {
      /* not remembered */
    }
  }, []);

  const value = useMemo(
    () => ({ plants, selected, select, loading: isLoading }),
    [plants, selected, select, isLoading],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
