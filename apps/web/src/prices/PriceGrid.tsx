import {
  cellKey,
  parsePriceCell,
  parsePricePaste,
  placePaste,
  type PriceUnit,
  type StagedEdit,
  type Staging,
} from '@khalta/engine';
import { cn, Ltr } from '@khalta/ui';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from '@khalta/ui';
import { useFormat } from '../lib/format';
import { usePrefs } from '../lib/prefs';
import type { MatrixCell, MatrixMaterial, MatrixPlant } from './api';

export interface Pos {
  r: number;
  c: number;
}
export interface Selection {
  anchor: Pos;
  focus: Pos;
}

const ROW_H = 52;
const FIRST_COL = '14rem';
const UNIT_KEY: Record<PriceUnit, string> = {
  'JOD/ton': 'ton',
  'JOD/kg': 'kg',
  'JOD/L': 'L',
  'JOD/m3': 'm3',
};

export const rect = (s: Selection) => ({
  r0: Math.min(s.anchor.r, s.focus.r),
  r1: Math.max(s.anchor.r, s.focus.r),
  c0: Math.min(s.anchor.c, s.focus.c),
  c1: Math.max(s.anchor.c, s.focus.c),
});

interface Props {
  rows: MatrixMaterial[];
  cols: MatrixPlant[];
  cellAt: (materialId: string, plantId: string) => MatrixCell | undefined;
  staging: Staging;
  onStage: (updates: { key: string; edit: StagedEdit | null }[]) => void;
  onUndo: () => void;
  onRedo: () => void;
  unitFor: (materialId: string) => PriceUnit;
  canEdit: boolean;
  heatmap: boolean;
  /** Median JOD/kg per material across the shown plants (heatmap reference). */
  medians: Map<string, number>;
  selection: Selection;
  onSelect: (s: Selection) => void;
}

/**
 * An ARIA grid over a pure staging model. Edits are staged locally (undoable) and saved together.
 * Arrow keys follow the reading direction; numbers and units are LTR islands.
 */
export function PriceGrid(p: Props) {
  const { t } = useTranslation();
  const { lang, dir } = usePrefs();
  const f = useFormat();
  const scroller = useRef<HTMLDivElement>(null);
  // set when a key already handled the edit, so the blur that follows does not commit it a second time
  const handled = useRef(false);
  const [editing, setEditing] = useState<{ pos: Pos; text: string; error?: string } | null>(null);
  const nRows = p.rows.length;
  const nCols = p.cols.length;

  const virt = useVirtualizer({
    count: nRows,
    getScrollElement: () => scroller.current,
    estimateSize: () => ROW_H,
    overscan: 8,
  });

  const focus = p.selection.focus;
  const sel = rect(p.selection);
  const colTemplate = `${FIRST_COL} repeat(${nCols}, minmax(7.5rem, 1fr))`;
  const minWidth = `calc(${FIRST_COL} + ${nCols} * 7.5rem)`;

  const move = useCallback(
    (dr: number, dc: number, extend: boolean) => {
      const next = {
        r: Math.max(0, Math.min(nRows - 1, p.selection.focus.r + dr)),
        c: Math.max(0, Math.min(nCols - 1, p.selection.focus.c + dc)),
      };
      p.onSelect({ anchor: extend ? p.selection.anchor : next, focus: next });
      virt.scrollToIndex(next.r, { align: 'auto' });
    },
    [nRows, nCols, p, virt],
  );
  // Left/right arrows move toward the physical edge, so in RTL they swap relative to column order.
  const horiz = dir === 'rtl' ? -1 : 1;

  const valueAt = (r: number, c: number) => {
    const m = p.rows[r];
    const pl = p.cols[c];
    if (!m || !pl) return '';
    const staged = p.staging.edits[cellKey(m.id, pl.id)];
    return staged?.price ?? p.cellAt(m.id, pl.id)?.price ?? '';
  };

  function commit(text: string, pos: Pos): string | null {
    const cell = parsePriceCell(text);
    if (cell.kind === 'empty') return null;
    if (cell.kind === 'error') return t(`prices.err.${cell.message}`);
    const m = p.rows[pos.r];
    const pl = p.cols[pos.c];
    if (m && pl)
      p.onStage([
        { key: cellKey(m.id, pl.id), edit: { price: cell.value, unit: p.unitFor(m.id) } },
      ]);
    return null;
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (editing || (e.target as HTMLElement).tagName === 'INPUT') return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      if (e.shiftKey) p.onRedo();
      else p.onUndo();
      return;
    }
    if (mod && e.key.toLowerCase() === 'y') {
      e.preventDefault();
      p.onRedo();
      return;
    }
    if (mod) return; // copy / paste are handled by their own events
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        move(1, 0, e.shiftKey);
        break;
      case 'ArrowUp':
        e.preventDefault();
        move(-1, 0, e.shiftKey);
        break;
      case 'ArrowRight':
        e.preventDefault();
        move(0, horiz, e.shiftKey);
        break;
      case 'ArrowLeft':
        e.preventDefault();
        move(0, -horiz, e.shiftKey);
        break;
      case 'PageDown':
        e.preventDefault();
        move(10, 0, e.shiftKey);
        break;
      case 'PageUp':
        e.preventDefault();
        move(-10, 0, e.shiftKey);
        break;
      case 'Home':
        e.preventDefault();
        move(0, -nCols, e.shiftKey);
        break;
      case 'End':
        e.preventDefault();
        move(0, nCols, e.shiftKey);
        break;
      case 'Enter':
      case 'F2':
        if (p.canEdit) {
          e.preventDefault();
          setEditing({ pos: focus, text: valueAt(focus.r, focus.c) });
        }
        break;
      case 'Delete':
      case 'Backspace': {
        if (!p.canEdit) break;
        e.preventDefault();
        const ups: { key: string; edit: null }[] = [];
        for (let r = sel.r0; r <= sel.r1; r++)
          for (let c = sel.c0; c <= sel.c1; c++) {
            const m = p.rows[r];
            const pl = p.cols[c];
            if (m && pl && p.staging.edits[cellKey(m.id, pl.id)])
              ups.push({ key: cellKey(m.id, pl.id), edit: null });
          }
        p.onStage(ups);
        break;
      }
      default:
        // typing a digit starts editing and replaces the content, like a spreadsheet
        if (p.canEdit && e.key.length === 1 && /[0-9٠-٩۰-۹.,٫]/.test(e.key)) {
          e.preventDefault();
          setEditing({ pos: focus, text: e.key });
        }
    }
  }

  function onCopy(e: React.ClipboardEvent) {
    if (editing) return;
    const lines: string[] = [];
    for (let r = sel.r0; r <= sel.r1; r++) {
      const line: string[] = [];
      for (let c = sel.c0; c <= sel.c1; c++) line.push(valueAt(r, c));
      lines.push(line.join('\t'));
    }
    e.clipboardData.setData('text/plain', lines.join('\n'));
    e.preventDefault();
  }

  function onPaste(e: React.ClipboardEvent) {
    if (editing || !p.canEdit) return;
    e.preventDefault();
    const { grid } = parsePricePaste(e.clipboardData.getData('text/plain'));
    const at = { row: sel.r0, col: sel.c0 };
    const res = placePaste(
      grid,
      at,
      p.rows.map((m) => m.id),
      p.cols.map((c) => c.id),
      (id) => p.unitFor(id),
    );
    p.onStage(res.updates);
    if (res.errors.length || res.clipped)
      toast.warning(
        t('prices.paste.problems', {
          ok: res.updates.length,
          errors: res.errors.length,
          clipped: res.clipped,
        }),
      );
    else toast.success(t('prices.paste.done', { count: res.updates.length }));
  }

  // keep the focused cell visible after external changes (e.g. undo)
  useEffect(() => {
    if (focus.r < nRows) virt.scrollToIndex(focus.r, { align: 'auto' });
  }, [focus.r]);

  const heat = useCallback(
    (m: MatrixMaterial, cell: MatrixCell | undefined) => {
      if (!p.heatmap || !cell?.jodPerKg) return null;
      const med = p.medians.get(m.id);
      if (!med) return null;
      const delta = (Number(cell.jodPerKg) - med) / med;
      return { delta, intensity: Math.min(Math.abs(delta) * 150, 35) };
    },
    [p.heatmap, p.medians],
  );

  const activeId = `pg-${focus.r}-${focus.c}`;
  const items = virt.getVirtualItems();
  const headerRow = useMemo(
    () => (
      <div
        role="row"
        aria-rowindex={1}
        className="sticky top-0 z-20 grid border-b border-line bg-surface"
        style={{ gridTemplateColumns: colTemplate, minWidth }}
      >
        <div
          role="columnheader"
          className="sticky start-0 z-30 flex items-center border-e border-line bg-surface px-3 text-sm font-medium text-muted"
          style={{ height: ROW_H }}
        >
          {t('prices.col.material')}
        </div>
        {p.cols.map((c, i) => (
          <div
            key={c.id}
            role="columnheader"
            aria-colindex={i + 2}
            className="flex flex-col justify-center px-3 text-sm"
            style={{ height: ROW_H }}
          >
            <Ltr mono className="text-xs text-muted">
              {c.code}
            </Ltr>
            <span className="truncate font-medium text-heading">
              {lang === 'ar' ? c.nameAr : c.nameEn}
            </span>
          </div>
        ))}
      </div>
    ),
    [p.cols, colTemplate, minWidth, lang, t],
  );

  return (
    <div
      ref={scroller}
      role="grid"
      tabIndex={0}
      aria-label={t('prices.grid.label')}
      aria-rowcount={nRows + 1}
      aria-colcount={nCols + 1}
      aria-multiselectable="true"
      aria-activedescendant={nRows && nCols ? activeId : undefined}
      aria-readonly={!p.canEdit}
      data-testid="price-grid"
      className="relative h-[min(70vh,44rem)] min-h-80 overflow-auto rounded-lg border border-line bg-surface focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
      onKeyDown={onKeyDown}
      onCopy={onCopy}
      onPaste={onPaste}
    >
      {headerRow}
      <div style={{ height: virt.getTotalSize(), minWidth, position: 'relative' }}>
        {items.map((v) => {
          const m = p.rows[v.index]!;
          return (
            <div
              key={m.id}
              role="row"
              aria-rowindex={v.index + 2}
              className="absolute start-0 grid w-full border-b border-line"
              style={{
                gridTemplateColumns: colTemplate,
                height: ROW_H,
                transform: `translateY(${v.start}px)`,
                minWidth,
              }}
            >
              <div
                role="rowheader"
                className="sticky start-0 z-10 flex flex-col justify-center border-e border-line bg-surface px-3"
              >
                <span className="truncate text-sm font-medium text-heading">
                  {lang === 'ar' ? (m.marketNameAr ?? m.marketNameEn) : m.marketNameEn}
                </span>
                <span className="flex items-center gap-2 text-xs text-muted">
                  {t(`materials.category.${m.category}`)}
                  <Ltr>{p.unitFor(m.id)}</Ltr>
                </span>
              </div>
              {p.cols.map((pl, ci) => {
                const cell = p.cellAt(m.id, pl.id);
                const staged = p.staging.edits[cellKey(m.id, pl.id)];
                const inSel =
                  v.index >= sel.r0 && v.index <= sel.r1 && ci >= sel.c0 && ci <= sel.c1;
                const isFocus = v.index === focus.r && ci === focus.c;
                const h = heat(m, cell);
                const stale = cell?.staleness?.status === 'stale';
                const shownPrice = staged?.price ?? cell?.price;
                const shownUnit = staged?.unit ?? cell?.unit;
                const isEditing = editing && editing.pos.r === v.index && editing.pos.c === ci;
                return (
                  <div
                    key={pl.id}
                    id={`pg-${v.index}-${ci}`}
                    role="gridcell"
                    aria-colindex={ci + 2}
                    aria-selected={inSel}
                    data-pending={staged ? 'true' : undefined}
                    data-stale={stale ? 'true' : undefined}
                    data-cell={`${m.marketNameEn}|${pl.code}`}
                    onMouseDown={(e) => {
                      p.onSelect(
                        e.shiftKey
                          ? { anchor: p.selection.anchor, focus: { r: v.index, c: ci } }
                          : { anchor: { r: v.index, c: ci }, focus: { r: v.index, c: ci } },
                      );
                      scroller.current?.focus();
                    }}
                    onDoubleClick={() =>
                      p.canEdit &&
                      setEditing({ pos: { r: v.index, c: ci }, text: shownPrice ?? '' })
                    }
                    className={cn(
                      'relative flex flex-col justify-center px-3 text-sm',
                      inSel && 'bg-primary-tint',
                      isFocus && 'outline-2 -outline-offset-2 outline-primary',
                      staged && 'outline-dashed outline-2 -outline-offset-2 outline-olive',
                    )}
                    style={{
                      ...(stale &&
                        !inSel && {
                          backgroundImage:
                            'repeating-linear-gradient(135deg, transparent 0 6px, color-mix(in srgb, var(--color-warn) 14%, transparent) 6px 8px)',
                        }),
                      ...(h &&
                        !inSel && {
                          backgroundColor: `color-mix(in srgb, var(${h.delta > 0 ? '--color-warn' : '--color-pass'}) ${h.intensity}%, transparent)`,
                        }),
                    }}
                  >
                    {isEditing ? (
                      <input
                        autoFocus
                        dir="ltr"
                        inputMode="decimal"
                        aria-label={t('prices.edit.label', {
                          material: m.marketNameEn,
                          plant: pl.code,
                        })}
                        aria-invalid={!!editing.error}
                        data-testid="price-editor"
                        className="h-9 w-full rounded-sm border border-primary bg-surface px-2 text-sm"
                        value={editing.text}
                        onChange={(e) =>
                          setEditing({ ...editing, text: e.target.value, error: undefined })
                        }
                        onBlur={() => {
                          if (handled.current) {
                            handled.current = false;
                            return;
                          }
                          if (!editing.error) {
                            const err = commit(editing.text, editing.pos);
                            if (err) toast.error(err);
                          }
                          setEditing(null);
                        }}
                        onKeyDown={(e) => {
                          e.stopPropagation();
                          if (e.key === 'Escape') {
                            handled.current = true;
                            setEditing(null);
                            scroller.current?.focus();
                          } else if (e.key === 'Enter' || e.key === 'Tab') {
                            e.preventDefault();
                            const err = commit(editing.text, editing.pos);
                            if (err) setEditing({ ...editing, error: err });
                            else {
                              handled.current = true;
                              setEditing(null);
                              scroller.current?.focus();
                              if (e.key === 'Enter') move(1, 0, false);
                              else move(0, e.shiftKey ? -horiz : horiz, false);
                            }
                          }
                        }}
                      />
                    ) : cell?.status === 'ambiguous' && !staged ? (
                      <span className="text-xs text-warn-text">{t('prices.cell.ambiguous')}</span>
                    ) : shownPrice ? (
                      <>
                        <span className="flex items-baseline gap-1">
                          <Ltr className="tabular font-medium text-heading">
                            {f.number(Number(shownPrice), {
                              minimumFractionDigits: 3,
                              maximumFractionDigits: 3,
                            })}
                          </Ltr>
                          {shownUnit && (
                            <Ltr className="text-[0.7rem] text-muted">
                              /{t(`prices.unitShort.${UNIT_KEY[shownUnit]}`)}
                            </Ltr>
                          )}
                        </span>
                        <span className="flex flex-wrap items-center gap-x-2 text-[0.7rem] text-muted">
                          {staged && (
                            <span className="text-olive-text">{t('prices.cell.pending')}</span>
                          )}
                          {!staged && stale && (
                            <span className="font-medium text-heading">
                              {t('prices.cell.age', { days: f.number(cell!.staleness!.ageDays) })}
                            </span>
                          )}
                          {!staged && cell?.notConvertible && (
                            <span>{t(`prices.cell.${cell.notConvertible}`)}</span>
                          )}
                          {!staged && cell?.includesDelivery === false && (
                            <span>{t('prices.cell.exDelivery')}</span>
                          )}
                          {!staged && (cell?.alternatives ?? 0) > 0 && (
                            <span>
                              {t('prices.cell.alternatives', { count: cell!.alternatives! })}
                            </span>
                          )}
                          {h && !staged && (
                            <Ltr>{`${h.delta >= 0 ? '+' : ''}${f.number(h.delta * 100, { maximumFractionDigits: 1 })}%`}</Ltr>
                          )}
                        </span>
                      </>
                    ) : (
                      <span className="text-xs text-muted" aria-label={t('prices.cell.none')}>
                        –
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}
