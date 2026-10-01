import { PRICE_PATTERN } from './convert';

export type PasteCell =
  | { kind: 'empty' }
  | { kind: 'value'; value: string }
  | { kind: 'error'; raw: string; message: string };
export interface PricePaste {
  grid: PasteCell[][];
  assumptions: string[];
}

const NBSP = String.fromCharCode(0xa0);
const digits = (s: string) =>
  s
    .replace(/[٠-٩]/g, (c) => String(c.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (c) => String(c.charCodeAt(0) - 0x06f0))
    .replace(/٫/g, '.');

/** Normalizes one typed or pasted price cell. Blank cells are "empty" (never zero). */
export function parsePriceCell(raw: string): PasteCell {
  let s = digits(raw)
    .trim()
    .replaceAll(NBSP, '')
    .replace(/JOD|د\.أ|دينار/gi, '')
    .trim();
  if (s === '') return { kind: 'empty' };
  if (/^\d+,\d{1,3}$/.test(s)) s = s.replace(',', '.'); // decimal comma
  if (!/^\d+(\.\d+)?$/.test(s)) return { kind: 'error', raw, message: 'not_a_number' };
  if (!PRICE_PATTERN.test(s))
    return {
      kind: 'error',
      raw,
      message: /\.\d{4,}/.test(s) ? 'too_many_decimals' : 'out_of_range',
    };
  return { kind: 'value', value: s };
}

/** Parses a block copied from Excel (tab separated; semicolons accepted). */
export function parsePricePaste(text: string): PricePaste {
  const lines = text.replace(/\r/g, '').split('\n');
  while (lines.length && lines[lines.length - 1]!.trim() === '') lines.pop(); // Excel adds a trailing newline
  const sep = lines.some((l) => l.includes('\t')) ? '\t' : ';';
  const assumptions: string[] = [];
  const grid = lines.map((l) => l.split(sep).map(parsePriceCell));
  if (digits(text) !== text) assumptions.push('digits');
  if (/\d,\d{1,3}(\t|;|\n|$)/.test(digits(text))) assumptions.push('decimal_comma');
  return { grid, assumptions };
}
