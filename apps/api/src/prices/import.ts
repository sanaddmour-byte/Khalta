import { parsePriceCell, PRICE_UNITS, type PriceUnit } from '@khalta/engine';
import ExcelJS from 'exceljs';
import Papa from 'papaparse';

export const MAX_IMPORT_BYTES = 5 * 1024 * 1024;
export const BOM = String.fromCharCode(0xfeff);
const stripBom = (s: string) => (s.startsWith(BOM) ? s.slice(1) : s);

const cellText = (v: ExcelJS.CellValue): string => {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    if ('result' in v && v.result !== undefined) return cellText(v.result as ExcelJS.CellValue);
    if ('richText' in v) return v.richText.map((t) => t.text).join('');
    if ('text' in v) return String(v.text);
    return '';
  }
  return String(v);
};

/** Reads the first sheet of an .xlsx (PK signature) or a CSV/TSV into rows of strings. */
export async function readTable(buf: Buffer, filename: string): Promise<string[][]> {
  const isXlsx = buf.subarray(0, 2).toString('latin1') === 'PK';
  if (isXlsx) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
    const ws = wb.worksheets[0];
    if (!ws) return [];
    const rows: string[][] = [];
    ws.eachRow({ includeEmpty: false }, (row) => {
      const cells: string[] = [];
      for (let c = 1; c <= ws.columnCount; c++) cells.push(cellText(row.getCell(c).value));
      rows.push(cells);
    });
    return rows;
  }
  if (!/\.(csv|tsv|txt)$/i.test(filename)) throw new Error('unsupported_file');
  const text = stripBom(buf.toString('utf8'));
  return Papa.parse<string[]>(text, { skipEmptyLines: 'greedy' }).data;
}

const ALIASES: Record<string, string[]> = {
  material: ['material', 'المادة', 'مادة'],
  plant: ['plant', 'plant code', 'المصنع', 'مصنع'],
  supplier: ['supplier', 'المورد', 'المورّد', 'مورد'],
  price: ['price', 'السعر', 'سعر'],
  unit: ['unit', 'الوحدة', 'وحدة'],
  includes_delivery: [
    'includes delivery',
    'includes_delivery',
    'delivery',
    'شامل التوصيل',
    'التوصيل',
  ],
  effective_from: ['effective from', 'effective_from', 'date', 'من تاريخ', 'تاريخ'],
  reason: ['reason', 'السبب', 'ملاحظة'],
};
export type Column = keyof typeof ALIASES;

/** Maps header cells to canonical columns. Returns the missing required ones. */
export function mapHeader(header: string[]): {
  index: Partial<Record<Column, number>>;
  missing: Column[];
} {
  const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');
  const index: Partial<Record<Column, number>> = {};
  header.forEach((h, i) => {
    for (const [col, names] of Object.entries(ALIASES))
      if (names.some((n) => norm(n) === norm(h)) && index[col as Column] === undefined)
        index[col as Column] = i;
  });
  const required: Column[] = ['material', 'plant', 'price', 'unit'];
  return { index, missing: required.filter((c) => index[c] === undefined) };
}

const UNIT_ALIASES: Record<string, PriceUnit> = {
  'jod/ton': 'JOD/ton',
  ton: 'JOD/ton',
  t: 'JOD/ton',
  طن: 'JOD/ton',
  'دينار/طن': 'JOD/ton',
  'jod/kg': 'JOD/kg',
  kg: 'JOD/kg',
  كغم: 'JOD/kg',
  كيلو: 'JOD/kg',
  'دينار/كغم': 'JOD/kg',
  'jod/l': 'JOD/L',
  l: 'JOD/L',
  litre: 'JOD/L',
  liter: 'JOD/L',
  لتر: 'JOD/L',
  'دينار/لتر': 'JOD/L',
  'jod/m3': 'JOD/m3',
  m3: 'JOD/m3',
  م3: 'JOD/m3',
  'دينار/م3': 'JOD/m3',
};
export function parseUnit(raw: string): PriceUnit | null {
  const k = raw.trim().toLowerCase().replace(/\s+/g, '').replace('³', '3');
  return (PRICE_UNITS as readonly string[]).includes(raw.trim())
    ? (raw.trim() as PriceUnit)
    : (UNIT_ALIASES[k] ?? null);
}

export function parseBool(raw: string): boolean | null {
  const k = raw.trim().toLowerCase();
  if (['yes', 'y', 'true', '1', 'نعم'].includes(k)) return true;
  if (['no', 'n', 'false', '0', 'لا'].includes(k)) return false;
  return null;
}

export function parseDateCell(raw: string): string | null {
  const s = raw.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s))) return s;
  const m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/);
  if (m) {
    const iso = `${m[3]}-${m[2]!.padStart(2, '0')}-${m[1]!.padStart(2, '0')}`;
    if (!Number.isNaN(Date.parse(iso)) && new Date(iso).toISOString().slice(0, 10) === iso)
      return iso;
  }
  return null;
}

export { parsePriceCell };
