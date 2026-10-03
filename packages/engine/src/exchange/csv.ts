// The CSV contract writer (M6.1, ADR 0015): UTF-8 with a byte-order mark, comma delimiter, CRLF line ends, RFC 4180
// quoting, `.` decimal point, no thousands separators. Pure. Numbers are never reformatted: callers pass the stored
// decimal text. Text cells that a spreadsheet would read as a formula are neutralised.

export const BOM = '﻿';
export type Cell = string | number | boolean | null | undefined;

/** A cell a spreadsheet could execute: starts with = + - @ tab or CR. */
const FORMULA_START = /^[=+\-@\t\r]/;
/** A plain decimal (what a number cell looks like), which may legitimately start with `-`. */
const NUMBER = /^-?\d+(\.\d+)?$/;

/** Text cells only: prefix a risky value with an apostrophe so it stays text. Numbers pass through unchanged. */
export function neutralise(text: string): string {
  return FORMULA_START.test(text) && !NUMBER.test(text) ? `'${text}` : text;
}

function quote(s: string): string {
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** A text cell (neutralised and quoted when needed). */
export const text = (v: string | null | undefined): string => quote(neutralise(v ?? ''));
/** A number or decimal-text cell, written as given. */
export function num(v: string | number | null | undefined): string {
  if (v === null || v === undefined || v === '') return '';
  const s = String(v);
  if (!NUMBER.test(s)) throw new Error(`not a plain decimal: ${s}`);
  return s;
}
export const bool = (v: boolean | null | undefined): string =>
  v === null || v === undefined ? '' : v ? 'true' : 'false';

/** Rows are already-encoded cells (use `text`, `num`, `bool`). */
export function toCsv(header: readonly string[], rows: readonly (readonly string[])[]): string {
  const width = header.length;
  for (const r of rows)
    if (r.length !== width) throw new Error('row width differs from the header');
  return BOM + [header.join(','), ...rows.map((r) => r.join(','))].join('\r\n') + '\r\n';
}
