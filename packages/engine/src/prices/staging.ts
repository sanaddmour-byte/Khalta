import type { PriceUnit } from './convert';
import type { PasteCell } from './paste';

export interface StagedEdit {
  price: string;
  unit: PriceUnit;
}
export type StagedEdits = Readonly<Record<string, StagedEdit>>;

export interface Staging {
  edits: StagedEdits;
  past: StagedEdits[];
  future: StagedEdits[];
}

export const cellKey = (materialId: string, plantId: string) => `${materialId}|${plantId}`;
export const splitKey = (key: string): [string, string] => key.split('|') as [string, string];
export const emptyStaging = (): Staging => ({ edits: {}, past: [], future: [] });

/** Applies updates (a `null` edit unstages the cell) as ONE undoable step. */
export function stage(
  s: Staging,
  updates: readonly { key: string; edit: StagedEdit | null }[],
): Staging {
  if (updates.length === 0) return s;
  const next: Record<string, StagedEdit> = { ...s.edits };
  for (const u of updates) {
    if (u.edit === null) delete next[u.key];
    else next[u.key] = u.edit;
  }
  return { edits: next, past: [...s.past, s.edits], future: [] };
}
export function undo(s: Staging): Staging {
  const prev = s.past[s.past.length - 1];
  return prev ? { edits: prev, past: s.past.slice(0, -1), future: [s.edits, ...s.future] } : s;
}
export function redo(s: Staging): Staging {
  const [next, ...rest] = s.future;
  return next ? { edits: next, past: [...s.past, s.edits], future: rest } : s;
}
export const clearStaging = (s: Staging): Staging =>
  Object.keys(s.edits).length
    ? stage(
        s,
        Object.keys(s.edits).map((key) => ({ key, edit: null })),
      )
    : s;

export interface PlaceResult {
  updates: { key: string; edit: StagedEdit }[];
  errors: { row: number; col: number; raw: string; message: string }[];
  /** Cells of the pasted block that fell outside the matrix. */
  clipped: number;
}

/**
 * Places a pasted block with its top-left corner at (row, col). Empty cells leave the target untouched;
 * invalid cells are reported and nothing is placed from them.
 */
export function placePaste(
  grid: readonly (readonly PasteCell[])[],
  at: { row: number; col: number },
  rows: readonly string[],
  cols: readonly string[],
  unitFor: (materialId: string) => PriceUnit,
): PlaceResult {
  const out: PlaceResult = { updates: [], errors: [], clipped: 0 };
  grid.forEach((line, r) =>
    line.forEach((cell, c) => {
      const materialId = rows[at.row + r];
      const plantId = cols[at.col + c];
      if (cell.kind === 'empty') return;
      if (materialId === undefined || plantId === undefined) {
        out.clipped++;
        return;
      }
      if (cell.kind === 'error')
        out.errors.push({ row: at.row + r, col: at.col + c, raw: cell.raw, message: cell.message });
      else
        out.updates.push({
          key: cellKey(materialId, plantId),
          edit: { price: cell.value, unit: unitFor(materialId) },
        });
    }),
  );
  return out;
}
