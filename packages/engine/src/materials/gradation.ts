import { isKnownSieve, DEFAULT_FM_SIEVES, parseSieve } from './sieves';

export interface GradationPoint {
  sieve_mm: number;
  passing_pct: number;
}

export type GradationErrorCode =
  | 'too_few_points'
  | 'unknown_sieve'
  | 'duplicate_sieve'
  | 'out_of_range'
  | 'not_monotonic'
  | 'top_not_100';

export interface GradationError {
  code: GradationErrorCode;
  sieve_mm?: number;
  message: string;
}

/**
 * Hard validation of a sieve analysis (07 §2.3): known sieves, no duplicates, 0–100, passing never
 * increases toward finer sieves, and 100% at the largest sieve.
 */
export function validateGradation(points: readonly GradationPoint[]): GradationError[] {
  const errors: GradationError[] = [];
  if (points.length < 2) errors.push({ code: 'too_few_points', message: 'a gradation needs at least two sieves' });
  const seen = new Set<number>();
  for (const p of points) {
    if (!isKnownSieve(p.sieve_mm)) errors.push({ code: 'unknown_sieve', sieve_mm: p.sieve_mm, message: `${p.sieve_mm} mm is not a standard sieve` });
    if (seen.has(p.sieve_mm)) errors.push({ code: 'duplicate_sieve', sieve_mm: p.sieve_mm, message: `sieve ${p.sieve_mm} mm appears twice` });
    seen.add(p.sieve_mm);
    if (!(p.passing_pct >= 0 && p.passing_pct <= 100)) errors.push({ code: 'out_of_range', sieve_mm: p.sieve_mm, message: `passing at ${p.sieve_mm} mm must be between 0 and 100` });
  }
  const sorted = [...points].sort((a, b) => b.sieve_mm - a.sieve_mm);
  for (let i = 1; i < sorted.length; i++) {
    const coarse = sorted[i - 1]!;
    const fine = sorted[i]!;
    if (fine.passing_pct > coarse.passing_pct)
      errors.push({ code: 'not_monotonic', sieve_mm: fine.sieve_mm, message: `passing rises from ${coarse.passing_pct}% at ${coarse.sieve_mm} mm to ${fine.passing_pct}% at ${fine.sieve_mm} mm` });
  }
  if (sorted[0] && sorted[0].passing_pct !== 100 && sorted[0].passing_pct >= 0 && sorted[0].passing_pct <= 100)
    errors.push({ code: 'top_not_100', sieve_mm: sorted[0].sieve_mm, message: `the largest sieve (${sorted[0].sieve_mm} mm) must show 100% passing` });
  return errors;
}

export type FmResult = { ok: true; fm: number } | { ok: false; missing: number[] };

/**
 * Fineness modulus = Σ cumulative % retained on the series ÷ 100. A series sieve that was not entered
 * is inferred only when the data forces it: a finer entered sieve at 100% passing means 0% retained,
 * a coarser entered sieve at 0% passing means 100% retained. Otherwise it is reported as missing.
 */
export function fineModulus(points: readonly GradationPoint[], series: readonly number[] = DEFAULT_FM_SIEVES): FmResult {
  const bySieve = new Map(points.map((p) => [p.sieve_mm, p.passing_pct]));
  const missing: number[] = [];
  let retained = 0;
  for (const s of series) {
    const exact = bySieve.get(s);
    if (exact !== undefined) {
      retained += 100 - exact;
      continue;
    }
    if (points.some((p) => p.sieve_mm < s && p.passing_pct === 100)) continue; // a finer sieve passes all, so this one does: 0% retained
    if (points.some((p) => p.sieve_mm > s && p.passing_pct === 0)) {
      retained += 100;
      continue;
    }
    missing.push(s);
  }
  return missing.length ? { ok: false, missing } : { ok: true, fm: retained / 100 };
}

export interface PasteResult {
  points: GradationPoint[];
  /** What the parser assumed, to be shown to the user before saving. */
  assumptions: string[];
  errors: string[];
}

const DIGITS: Record<string, string> = { '٠': '0', '١': '1', '٢': '2', '٣': '3', '٤': '4', '٥': '5', '٦': '6', '٧': '7', '٨': '8', '٩': '9', '۰': '0', '۱': '1', '۲': '2', '۳': '3', '۴': '4', '۵': '5', '۶': '6', '۷': '7', '۸': '8', '۹': '9', '٫': '.' };
const latin = (s: string) => s.replace(/[٠-٩۰-۹٫]/g, (c) => DIGITS[c] ?? c);

function parsePassing(cell: string): number | null {
  const c = latin(cell).replace('%', '').trim().replace(/,/g, '.');
  if (c === '' || !/^-?\d+(\.\d+)?$/.test(c)) return null;
  return Number(c);
}

/**
 * Parses a gradation pasted from Excel: either two columns (sieve, % passing) one sieve per line, or a
 * row of sieves above a row of % passing. Cells split on tabs, else semicolons, else commas. Arabic-Indic
 * digits and decimal commas are accepted. Nothing is guessed silently: assumptions are returned.
 */
export function parseGradationPaste(text: string): PasteResult {
  const assumptions: string[] = [];
  const errors: string[] = [];
  const lines = latin(text)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) return { points: [], assumptions, errors: ['nothing to parse'] };

  const sep = lines.some((l) => l.includes('\t')) ? '\t' : lines.some((l) => l.includes(';')) ? ';' : ',';
  const decimalComma = sep !== ',';
  const split = (l: string) => l.split(sep).map((c) => (decimalComma ? c.replace(/(\d),(\d)/g, '$1.$2') : c).trim());
  let rows = lines.map(split);

  // header row ("Sieve", "% passing") is dropped when its first cell is not a sieve
  const looksLikeHeader = (r: string[]) => r.length > 0 && parseSieve(r[0]!) === null && r.every((c) => parsePassing(c) === null);
  if (rows.length > 1 && looksLikeHeader(rows[0]!) && rows.slice(1).every((r) => r.length === 2)) {
    assumptions.push('the first line was read as a header');
    rows = rows.slice(1);
  }

  const points: GradationPoint[] = [];
  const add = (sieveCell: string, passCell: string, where: string) => {
    const s = parseSieve(sieveCell);
    const p = parsePassing(passCell);
    if (s === null) errors.push(`${where}: "${sieveCell}" is not a sieve size`);
    else if (p === null) errors.push(`${where}: "${passCell}" is not a percentage`);
    else points.push({ sieve_mm: s, passing_pct: p });
  };

  const twoColumns = rows.every((r) => r.length === 2);
  const rowOrientation = rows.length === 2 && rows[0]!.length === rows[1]!.length && rows[0]!.length >= 3;
  if (twoColumns) {
    assumptions.push('one sieve per line: sieve size, then % passing');
    rows.forEach((r, i) => add(r[0]!, r[1]!, `line ${i + 1}`));
  } else if (rowOrientation) {
    assumptions.push('first row = sieve sizes, second row = % passing');
    rows[0]!.forEach((c, i) => add(c, rows[1]![i]!, `column ${i + 1}`));
  } else {
    errors.push('could not tell the layout: paste two columns (sieve, % passing) or a row of sieves above a row of % passing');
  }
  if (points.length > 0) assumptions.push('values are % PASSING (not retained)');
  return { points: points.sort((a, b) => b.sieve_mm - a.sieve_mm), assumptions, errors };
}
