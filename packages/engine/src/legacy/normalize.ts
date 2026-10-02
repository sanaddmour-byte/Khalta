// Name matching for Arabic-first material names. Normalization removes spelling noise (diacritics, tatweel,
// alef/ya/ta-marbuta variants, digits, spacing); it never decides that two different names are the same.

const DIACRITICS = /[ً-ٰٟۖ-ۭ]/g;
const TATWEEL = /ـ/g;
const ARABIC_INDIC = /[٠-٩]/g;
const EXT_INDIC = /[۰-۹]/g;

/** Canonical comparison form of a material name. Idempotent. */
export function normalizeName(raw: string): string {
  return raw
    .normalize('NFKC')
    .replace(DIACRITICS, '')
    .replace(TATWEEL, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي')
    .replace(ARABIC_INDIC, (c) => String(c.charCodeAt(0) - 0x0660))
    .replace(EXT_INDIC, (c) => String(c.charCodeAt(0) - 0x06f0))
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

const bigrams = (s: string): string[] => {
  const t = s.replace(/ /g, '');
  if (t.length < 2) return t ? [t] : [];
  const out: string[] = [];
  for (let i = 0; i < t.length - 1; i++) out.push(t.slice(i, i + 2));
  return out;
};

/** Sørensen–Dice similarity of two names (0..1). Used only to ORDER suggestions, never to accept one. */
export function similarity(a: string, b: string): number {
  const x = bigrams(normalizeName(a));
  const y = bigrams(normalizeName(b));
  if (x.length === 0 || y.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const g of y) counts.set(g, (counts.get(g) ?? 0) + 1);
  let hit = 0;
  for (const g of x) {
    const n = counts.get(g) ?? 0;
    if (n > 0) {
      hit++;
      counts.set(g, n - 1);
    }
  }
  return (2 * hit) / (x.length + y.length);
}
