import { normalizeName, similarity } from './normalize';

export interface MatchCandidate {
  id: string;
  category: string;
  names: readonly (string | null | undefined)[];
}
export interface Suggestion {
  id: string;
  /** Internal ordering score only; not shown as a probability. */
  score: number;
  categoryMismatch: boolean;
}
export interface MatchResult {
  /** Set only when exactly one same-category candidate has an exactly equal normalized name. */
  exactId: string | null;
  ambiguous: boolean;
  suggestions: Suggestion[];
}

/**
 * Finds the library material a legacy name refers to. Only an exact normalized match in the same category is
 * ever pre-selected; everything else is a ranked suggestion that a person must confirm.
 */
export function matchMaterial(
  name: string,
  category: string,
  candidates: readonly MatchCandidate[],
  max = 5,
): MatchResult {
  const target = normalizeName(name);
  const exact = target
    ? candidates.filter(
        (c) => c.category === category && c.names.some((n) => n && normalizeName(n) === target),
      )
    : [];
  const suggestions = candidates
    .map((c) => ({
      id: c.id,
      score: Math.max(0, ...c.names.map((n) => (n ? similarity(name, n) : 0))),
      categoryMismatch: c.category !== category,
    }))
    .filter((s) => s.score > 0.3 || exact.some((e) => e.id === s.id))
    .sort(
      (a, b) =>
        Number(a.categoryMismatch) - Number(b.categoryMismatch) ||
        b.score - a.score ||
        a.id.localeCompare(b.id),
    )
    .slice(0, max);
  return {
    exactId: exact.length === 1 ? exact[0]!.id : null,
    ambiguous: exact.length > 1,
    suggestions,
  };
}
