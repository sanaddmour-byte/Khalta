// Sieve sizes are numeric millimetres internally. Entry accepts the standard labels below; no free text.

/** ASTM E11 sieves (US labels) → mm. */
export const US_SIEVES: Record<string, number> = {
  '3 in': 75,
  '2 in': 50,
  '1.5 in': 37.5,
  '1 in': 25,
  '3/4 in': 19,
  '1/2 in': 12.5,
  '3/8 in': 9.5,
  'No. 4': 4.75,
  'No. 8': 2.36,
  'No. 16': 1.18,
  'No. 30': 0.6,
  'No. 50': 0.3,
  'No. 100': 0.15,
  'No. 200': 0.075,
};

/** ISO / BS EN sieves (mm). */
export const ISO_SIEVES: readonly number[] = [63, 31.5, 16, 8, 4, 2, 1, 0.5, 0.25, 0.125, 0.063];

/** Every sieve size a gradation may use (ASTM ∪ ISO), descending. */
export const KNOWN_SIEVES: readonly number[] = [
  ...new Set([...Object.values(US_SIEVES), ...ISO_SIEVES, 150, 100]),
].sort((a, b) => b - a);

/** Starter fineness-modulus series (ASTM C125 / C136). The authoritative value is the engineering seed `eng.fm.sieves`. */
export const DEFAULT_FM_SIEVES: readonly number[] = [
  150, 75, 37.5, 19, 9.5, 4.75, 2.36, 1.18, 0.6, 0.3, 0.15,
];

const compact = (s: string) => s.toLowerCase().replace(/\s+/g, '');
const US_BY_LABEL = new Map(Object.entries(US_SIEVES).map(([label, mm]) => [compact(label), mm]));

/** "#4", "no4", "No. 4" → "no.4"; 3/8" and "3/8 inch" → "3/8in". */
function normalizeLabel(s: string): string {
  return compact(s)
    .replace(/["”″]/g, 'in')
    .replace(/inch(es)?$/, 'in')
    .replace(/^#/, 'no.')
    .replace(/^no(?=\d)/, 'no.');
}

/** Parses a sieve cell: "4.75", "4.75 mm", "No. 4", "#4", '3/8"', "300 µm". Returns mm or null. */
export function parseSieve(cell: string): number | null {
  const raw = cell.trim();
  if (!raw) return null;
  const micro = raw.match(/^([\d.,]+)\s*(µm|μm|um|micron)s?$/i);
  if (micro) {
    const v = Number(micro[1]!.replace(',', '.')) / 1000;
    return Number.isFinite(v) && v > 0 ? v : null;
  }
  const mm = raw.match(/^([\d.,]+)\s*(mm)?$/i);
  if (mm) {
    const v = Number(mm[1]!.replace(',', '.'));
    return Number.isFinite(v) && v > 0 ? v : null;
  }
  return US_BY_LABEL.get(normalizeLabel(raw)) ?? null;
}

export const isKnownSieve = (mm: number) => KNOWN_SIEVES.some((s) => Math.abs(s - mm) < 1e-9);

/** Human label for a sieve in mm (US label when there is one). */
export function sieveLabel(mm: number): string {
  const us = Object.entries(US_SIEVES).find(([, v]) => Math.abs(v - mm) < 1e-9);
  return us ? `${mm} mm (${us[0]})` : `${mm} mm`;
}
