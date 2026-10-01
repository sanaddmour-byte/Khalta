// Offline-safe local drafts for lab entry: autosaved per user and target, never including files, and
// removed on sign-out so a shared tablet does not leak values to the next user.
const PREFIX = 'khalta.draft.';

export interface Draft {
  values: Record<string, string>;
  gradation: { sieve_mm: number; passing_pct: number }[];
  table: { dosage_pct: string; water_reduction_pct: string }[];
  extra: Record<string, string>;
  savedAt: number;
}

const key = (userId: string, target: string) => `${PREFIX}${userId}.${target}`;

export function loadDraft(userId: string, target: string): Draft | null {
  try {
    const raw = window.localStorage.getItem(key(userId, target));
    return raw ? (JSON.parse(raw) as Draft) : null;
  } catch {
    return null;
  }
}
export function saveDraft(userId: string, target: string, draft: Omit<Draft, 'savedAt'>) {
  try {
    window.localStorage.setItem(
      key(userId, target),
      JSON.stringify({ ...draft, savedAt: Date.now() }),
    );
  } catch {
    /* storage unavailable: the draft is simply not kept */
  }
}
export function clearDraft(userId: string, target: string) {
  try {
    window.localStorage.removeItem(key(userId, target));
  } catch {
    /* nothing to clear */
  }
}
export function clearAllDrafts() {
  try {
    for (const k of Object.keys(window.localStorage))
      if (k.startsWith(PREFIX)) window.localStorage.removeItem(k);
  } catch {
    /* nothing to clear */
  }
}
