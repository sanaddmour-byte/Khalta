import {
  clearStaging,
  emptyStaging,
  redo,
  splitKey,
  stage,
  todayAmman,
  undo,
  type PriceUnit,
  type StagedEdit,
  type Staging,
} from '@khalta/engine';
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  EmptyState,
  Input,
  Label,
  Ltr,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  Switch,
  toast,
} from '@khalta/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, CircleDollarSign, Download, History, Redo2, Undo2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../lib/api';
import { useMe } from '../lib/auth';
import { useFormat } from '../lib/format';
import { ALL, usePlant } from '../lib/plant';
import { usePrefs } from '../lib/prefs';
import { SectionPage } from '../pages/Section';
import { exportPrices, matrixQuery, savePrices, type MatrixCell, type SetEntry } from './api';
import {
  BulkDialog,
  CopyDialog,
  HistorySheet,
  ImportDialog,
  SnapshotDialog,
  SupplierDialog,
} from './PriceDialogs';
import { PriceGrid, type Selection } from './PriceGrid';

const DEFAULT_UNIT: Record<string, PriceUnit> = {
  cement: 'JOD/ton',
  scm: 'JOD/ton',
  fine_agg: 'JOD/ton',
  coarse_agg: 'JOD/ton',
  admixture: 'JOD/L',
  water: 'JOD/m3',
  fiber: 'JOD/kg',
  pigment: 'JOD/kg',
};

type Dialog = 'bulk' | 'copy' | 'import' | 'snapshot' | null;

export function PricesPage() {
  const { t } = useTranslation();
  const { lang } = usePrefs();
  const f = useFormat();
  const qc = useQueryClient();
  const { data: me } = useMe();
  const { selected } = usePlant();
  const caps = me?.capabilities ?? [];
  const canView = caps.includes('price.view');
  const canEdit = caps.includes('price.edit');
  const canExport = caps.includes('export.priceCost');
  const [asOf, setAsOf] = useState('');
  const today = todayAmman();
  const { data, isLoading, isError } = useQuery({
    ...matrixQuery(asOf || undefined),
    enabled: canView,
  });

  const [staging, setStaging] = useState<Staging>(emptyStaging());
  const [selection, setSelection] = useState<Selection>({
    anchor: { r: 0, c: 0 },
    focus: { r: 0, c: 0 },
  });
  const [q, setQ] = useState('');
  const [heatmap, setHeatmap] = useState(false);
  const [effectiveFrom, setEffectiveFrom] = useState(today);
  const [reason, setReason] = useState('');
  const [rowUnits, setRowUnits] = useState<Record<string, PriceUnit>>({});
  const [dialog, setDialog] = useState<Dialog>(null);
  const [history, setHistory] = useState<{ materialId: string; plantId: string } | null>(null);
  const [needSupplier, setNeedSupplier] = useState<string[] | null>(null);

  const cols = useMemo(() => {
    const all = data?.plants ?? [];
    return selected && selected !== ALL ? all.filter((p) => p.id === selected) : all;
  }, [data, selected]);
  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (data?.materials ?? []).filter(
      (m) =>
        !needle ||
        [m.marketNameEn, m.marketNameAr ?? ''].some((s) => s.toLowerCase().includes(needle)),
    );
  }, [data, q]);
  const cellMap = useMemo(
    () => new Map((data?.cells ?? []).map((c) => [`${c.materialId}|${c.plantId}`, c])),
    [data],
  );
  const cellAt = (m: string, p: string): MatrixCell | undefined => cellMap.get(`${m}|${p}`);
  const medians = useMemo(() => {
    const out = new Map<string, number>();
    for (const m of rows) {
      const v = cols
        .map((c) => cellMap.get(`${m.id}|${c.id}`)?.jodPerKg)
        .filter((x): x is string => !!x)
        .map(Number)
        .sort((a, b) => a - b);
      if (v.length >= 2)
        out.set(
          m.id,
          v.length % 2 ? v[(v.length - 1) / 2]! : (v[v.length / 2 - 1]! + v[v.length / 2]!) / 2,
        );
    }
    return out;
  }, [rows, cols, cellMap]);

  const unitFor = (materialId: string): PriceUnit => {
    if (rowUnits[materialId]) return rowUnits[materialId]!;
    const existing = cols.map((c) => cellMap.get(`${materialId}|${c.id}`)?.unit).find(Boolean);
    return (
      existing ??
      DEFAULT_UNIT[data?.materials.find((m) => m.id === materialId)?.category ?? ''] ??
      'JOD/ton'
    );
  };

  const pending = Object.keys(staging.edits).length;
  const backdated = effectiveFrom < today;
  const readOnlyView = !!asOf && asOf !== today;
  const stageEdits = (u: { key: string; edit: StagedEdit | null }[]) =>
    setStaging((s) => stage(s, u));

  const save = useMutation({
    mutationFn: async (supplierId?: string) => {
      const entries: SetEntry[] = Object.entries(staging.edits).map(([key, e]) => {
        const [materialId, plantId] = splitKey(key);
        return {
          materialId,
          plantId,
          price: e.price,
          unit: e.unit,
          ...(supplierId && needSupplier?.includes(key) && { supplierId }),
        };
      });
      return savePrices({
        entries,
        effectiveFrom,
        ...(reason.trim() && { reason: reason.trim() }),
      });
    },
    onSuccess: async (r) => {
      setStaging(emptyStaging());
      setNeedSupplier(null);
      setReason('');
      await qc.invalidateQueries({ queryKey: ['prices'] });
      toast.success(t('prices.saved', { applied: r.applied, unchanged: r.unchanged }));
    },
    onError: (e) => {
      if (e instanceof ApiError && e.code === 'supplier_required') {
        const cells =
          (e.details as { cells?: { materialId: string; plantId: string }[] } | undefined)?.cells ??
          [];
        setNeedSupplier(cells.map((c) => `${c.materialId}|${c.plantId}`));
        return;
      }
      toast.error(e instanceof ApiError ? e.message : t('errors.network'));
    },
  });

  if (me && !canView) return <SectionPage id="prices" />;

  const focusM = rows[selection.focus.r];
  const focusP = cols[selection.focus.c];
  const focusCell = focusM && focusP ? cellAt(focusM.id, focusP.id) : undefined;
  const supplierName = (id?: string) => {
    const s = data?.suppliers.find((x) => x.id === id);
    return s ? (lang === 'ar' ? s.nameAr : s.nameEn) : '';
  };
  const sum = data?.summary;

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-heading">{t('nav.prices')}</h1>
          <p className="mt-1 max-w-3xl text-sm text-muted">{t('prices.intro')}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {canEdit && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="secondary" data-testid="price-tools">
                  {t('prices.tools')}
                  <ChevronDown className="size-4" aria-hidden />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => setDialog('bulk')} data-testid="tool-bulk">
                  {t('prices.bulk.title')}
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => setDialog('copy')} data-testid="tool-copy">
                  {t('prices.copy.title')}
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => setDialog('import')} data-testid="tool-import">
                  {t('prices.import.title')}
                </DropdownMenuItem>
                <DropdownMenuItem
                  onSelect={() => setDialog('snapshot')}
                  data-testid="tool-snapshot"
                >
                  {t('prices.snapshot.title')}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          {canExport && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="secondary" data-testid="price-export">
                  <Download className="size-4" aria-hidden />
                  {t('prices.export')}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => void exportPrices('xlsx', asOf || undefined)}>
                  {t('prices.format.xlsx')}
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => void exportPrices('csv', asOf || undefined)}>
                  {t('prices.format.csv')}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </header>

      {sum && (
        <p className="text-sm text-muted" data-testid="price-summary" role="status">
          {t('prices.summary', { priced: f.number(sum.priced), pairs: f.number(sum.pairs) })}
          {' · '}
          {sum.staleLimitDays === null
            ? t('prices.staleNotSet')
            : t('prices.staleCount', { count: sum.stale })}
          {sum.ambiguous > 0 && ` · ${t('prices.ambiguousCount', { count: sum.ambiguous })}`}
          {sum.notConvertible > 0 &&
            ` · ${t('prices.notConvertibleCount', { count: sum.notConvertible })}`}
        </p>
      )}

      <div className="flex flex-wrap items-end gap-3" role="search" aria-label={t('rules.filters')}>
        <div className="w-60 max-w-full">
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t('materials.search')}
            aria-label={t('materials.search')}
            data-testid="price-search"
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="asof" className="text-xs text-muted">
            {t('prices.asOf')}
          </Label>
          <Input
            id="asof"
            type="date"
            dir="ltr"
            className="w-40"
            value={asOf || today}
            onChange={(e) => setAsOf(e.target.value === today ? '' : e.target.value)}
          />
        </div>
        <label className="flex items-center gap-2 text-sm">
          <Switch
            checked={heatmap}
            onCheckedChange={setHeatmap}
            aria-label={t('prices.heatmap')}
            data-testid="heatmap-toggle"
          />
          {t('prices.heatmap')}
        </label>
        {focusM && canEdit && (
          <div className="flex flex-col gap-1">
            <Label htmlFor="rowunit" className="text-xs text-muted">
              {t('prices.rowUnit', {
                name:
                  lang === 'ar'
                    ? (focusM.marketNameAr ?? focusM.marketNameEn)
                    : focusM.marketNameEn,
              })}
            </Label>
            <Select
              value={unitFor(focusM.id)}
              onValueChange={(u) => setRowUnits((s) => ({ ...s, [focusM.id]: u as PriceUnit }))}
            >
              <SelectTrigger
                id="rowunit"
                className="w-40"
                aria-label={t('prices.rowUnitShort')}
                data-testid="row-unit"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(['JOD/ton', 'JOD/kg', 'JOD/L', 'JOD/m3'] as const).map((u) => (
                  <SelectItem key={u} value={u}>
                    <Ltr>{u}</Ltr>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
      </div>

      {canEdit && !readOnlyView && (
        <div
          className="flex flex-wrap items-end gap-3 rounded-lg border border-line bg-surface p-3"
          data-testid="staging-bar"
        >
          <div className="flex flex-col gap-1">
            <Label htmlFor="eff" className="text-xs text-muted">
              {t('prices.effectiveFrom')}
            </Label>
            <Input
              id="eff"
              type="date"
              dir="ltr"
              className="w-40"
              value={effectiveFrom}
              onChange={(e) => setEffectiveFrom(e.target.value)}
              data-testid="effective-from"
            />
          </div>
          <div className="flex min-w-48 grow flex-col gap-1">
            <Label htmlFor="why" className="text-xs text-muted">
              {backdated ? t('prices.reasonRequired') : t('prices.reason')}
            </Label>
            <Input
              id="why"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder={t('prices.reasonPlaceholder')}
              aria-invalid={backdated && reason.trim().length < 3}
              data-testid="price-reason"
            />
          </div>
          <Button
            variant="ghost"
            size="icon"
            aria-label={t('prices.undo')}
            disabled={staging.past.length === 0}
            onClick={() => setStaging(undo)}
            data-testid="undo"
          >
            <Undo2 className="size-4" aria-hidden />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label={t('prices.redo')}
            disabled={staging.future.length === 0}
            onClick={() => setStaging(redo)}
            data-testid="redo"
          >
            <Redo2 className="size-4" aria-hidden />
          </Button>
          <Button
            variant="secondary"
            disabled={pending === 0}
            onClick={() => setStaging(clearStaging)}
            data-testid="discard"
          >
            {t('prices.discard')}
          </Button>
          <Button
            disabled={pending === 0 || save.isPending || (backdated && reason.trim().length < 3)}
            onClick={() => save.mutate(undefined)}
            data-testid="save-prices"
          >
            {t('prices.save', { count: pending })}
          </Button>
        </div>
      )}
      {readOnlyView && (
        <p className="rounded-md bg-olive-tint p-3 text-sm text-olive-text" role="status">
          {t('prices.asOfNote', { date: asOf })}
        </p>
      )}

      {isLoading && <Skeleton className="h-64 w-full" />}
      {isError && (
        <p role="alert" className="text-sm text-fail-text">
          {t('errors.loadFailed')}
        </p>
      )}
      {data && (rows.length === 0 || cols.length === 0) && (
        <EmptyState
          icon={<CircleDollarSign className="size-8" aria-hidden />}
          title={t('prices.empty.title')}
          description={t('prices.empty.description')}
        />
      )}
      {data && rows.length > 0 && cols.length > 0 && (
        <>
          <PriceGrid
            rows={rows}
            cols={cols}
            cellAt={cellAt}
            staging={staging}
            onStage={stageEdits}
            onUndo={() => setStaging(undo)}
            onRedo={() => setStaging(redo)}
            unitFor={unitFor}
            canEdit={canEdit && !readOnlyView}
            heatmap={heatmap}
            medians={medians}
            selection={selection}
            onSelect={setSelection}
          />
          <div
            className="flex min-h-12 flex-wrap items-center justify-between gap-3 text-sm"
            data-testid="cell-detail"
            aria-live="polite"
          >
            {focusM && focusP && (
              <>
                <span>
                  <strong>
                    {lang === 'ar'
                      ? (focusM.marketNameAr ?? focusM.marketNameEn)
                      : focusM.marketNameEn}
                  </strong>{' '}
                  · <Ltr mono>{focusP.code}</Ltr>
                  {focusCell?.status === 'ok' && (
                    <span className="text-muted">
                      {' · '}
                      {supplierName(focusCell.supplierId)} ·{' '}
                      <Ltr className="whitespace-nowrap">{focusCell.effectiveFrom}</Ltr>
                      {focusCell.jodPerKg ? (
                        <>
                          {' '}
                          ·{' '}
                          <Ltr>
                            {f.number(Number(focusCell.jodPerKg), {
                              minimumFractionDigits: 4,
                              maximumFractionDigits: 4,
                            })}
                          </Ltr>{' '}
                          {t('prices.perKg')}
                        </>
                      ) : null}
                    </span>
                  )}
                </span>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => setHistory({ materialId: focusM.id, plantId: focusP.id })}
                  data-testid="open-history"
                >
                  <History className="size-4" aria-hidden />
                  {t('prices.history.open2')}
                </Button>
              </>
            )}
          </div>
          <p className="text-xs text-muted">{t('prices.keys')}</p>
        </>
      )}

      {history && data && (
        <HistorySheet
          matrix={data}
          materialId={history.materialId}
          plantId={history.plantId}
          canEdit={canEdit}
          onClose={() => setHistory(null)}
        />
      )}
      {dialog === 'bulk' && data && <BulkDialog matrix={data} onClose={() => setDialog(null)} />}
      {dialog === 'copy' && data && <CopyDialog matrix={data} onClose={() => setDialog(null)} />}
      {dialog === 'import' && data && (
        <ImportDialog matrix={data} onClose={() => setDialog(null)} />
      )}
      {dialog === 'snapshot' && <SnapshotDialog onClose={() => setDialog(null)} />}
      {needSupplier && data && (
        <SupplierDialog
          matrix={data}
          count={needSupplier.length}
          onClose={() => setNeedSupplier(null)}
          onChoose={(s) => save.mutate(s)}
        />
      )}
    </div>
  );
}
