import {
  Button,
  Checkbox,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  Input,
  Label,
  Ltr,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  SheetContent,
  Skeleton,
  toast,
} from '@khalta/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ShieldCheck, X } from 'lucide-react';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../lib/api';
import { useFormat } from '../lib/format';
import { usePrefs } from '../lib/prefs';
import {
  bulkApply,
  bulkPreview,
  commitImport,
  copyPrices,
  createSnapshot,
  historyQuery,
  previewImport,
  setPreferred,
  snapshotsQuery,
  type ImportPreview,
  type Matrix,
} from './api';

const ALL = '__all';
const msg = (e: unknown, fallback: string) => (e instanceof ApiError ? e.message : fallback);

export function Sparkline({ values }: { values: number[] }) {
  const { t } = useTranslation();
  if (values.length < 2) return null;
  const min = Math.min(...values);
  const span = Math.max(...values) - min || 1;
  const pts = values.map(
    (v, i) => `${(i / (values.length - 1)) * 116 + 2},${30 - 3 - ((v - min) / span) * 24}`,
  );
  return (
    <span dir="ltr" className="inline-block">
      <svg
        width={120}
        height={30}
        viewBox="0 0 120 30"
        role="img"
        aria-label={t('prices.history.trend', { count: values.length })}
        className="text-primary"
      >
        <polyline
          points={pts.join(' ')}
          fill="none"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinejoin="round"
        />
      </svg>
    </span>
  );
}

/** Every price ever entered for one cell, with who/why, a trend line and a supplier preference switch. */
export function HistorySheet({
  matrix,
  materialId,
  plantId,
  canEdit,
  onClose,
}: {
  matrix: Matrix;
  materialId: string;
  plantId: string;
  canEdit: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { lang } = usePrefs();
  const f = useFormat();
  const qc = useQueryClient();
  const { data, isLoading } = useQuery(historyQuery(materialId, plantId));
  const m = matrix.materials.find((x) => x.id === materialId);
  const pl = matrix.plants.find((x) => x.id === plantId);
  const sup = (id: string) => {
    const s = matrix.suppliers.find((x) => x.id === id);
    return s ? (lang === 'ar' ? s.nameAr : s.nameEn) : '';
  };
  const prefer = useMutation({
    mutationFn: (supplierId: string) => setPreferred({ materialId, plantId, supplierId }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['prices'] });
      toast.success(t('prices.history.preferred'));
    },
    onError: (e) => toast.error(msg(e, t('errors.network'))),
  });
  const live = (data ?? []).filter((r) => !r.supersededAt);
  const series = [...live]
    .sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom))
    .map((r) => Number(r.price));
  const current = matrix.cells.find((c) => c.materialId === materialId && c.plantId === plantId);
  const suppliers = [
    ...new Set(live.filter((r) => r.effectiveTo === null).map((r) => r.supplierId)),
  ];

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <SheetContent
        side="end"
        className="w-[34rem] max-w-full overflow-y-auto"
        data-testid="history-sheet"
      >
        <div className="mb-3 flex items-start justify-between gap-2">
          <div>
            <DialogTitle className="text-base font-semibold text-heading">
              {m ? (lang === 'ar' ? (m.marketNameAr ?? m.marketNameEn) : m.marketNameEn) : ''}
            </DialogTitle>
            <DialogDescription className="text-sm text-muted">
              {t('prices.history.title')} · <Ltr mono>{pl?.code}</Ltr>
            </DialogDescription>
          </div>
          <Button variant="ghost" size="icon" aria-label={t('ui.close')} onClick={onClose}>
            <X className="size-4" aria-hidden />
          </Button>
        </div>
        <Sparkline values={series} />
        {suppliers.length > 1 && canEdit && (
          <section
            className="mt-4 rounded-md border border-line p-3"
            aria-label={t('prices.history.supplier')}
          >
            <h3 className="mb-2 text-sm font-semibold text-heading">
              {t('prices.history.supplier')}
            </h3>
            <p className="mb-2 text-xs text-muted">{t('prices.history.supplierHint')}</p>
            <ul className="flex flex-col gap-2">
              {suppliers.map((s) => (
                <li key={s} className="flex items-center justify-between gap-2 text-sm">
                  <span>{sup(s)}</span>
                  {current?.supplierId === s ? (
                    <span className="inline-flex items-center gap-1 text-xs text-pass-text">
                      <ShieldCheck className="size-3.5" aria-hidden />
                      {t('prices.history.usedNow')}
                    </span>
                  ) : (
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={prefer.isPending}
                      onClick={() => prefer.mutate(s)}
                    >
                      {t('prices.history.prefer')}
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          </section>
        )}
        {isLoading && <Skeleton className="mt-4 h-16 w-full" />}
        <ol className="mt-4 flex flex-col gap-3" data-testid="price-history">
          {(data ?? []).map((r) => (
            <li
              key={r.id}
              className={`rounded-md border border-line p-3 text-sm ${r.supersededAt ? 'opacity-60' : ''}`}
            >
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <strong className="tabular">
                  <Ltr>
                    {f.number(Number(r.price), {
                      minimumFractionDigits: 3,
                      maximumFractionDigits: 3,
                    })}
                  </Ltr>{' '}
                  <Ltr className="text-xs text-muted">{r.unit}</Ltr>
                </strong>
                <span className="text-xs text-muted">
                  <Ltr className="whitespace-nowrap">{r.effectiveFrom}</Ltr> →{' '}
                  {r.effectiveTo ? (
                    <Ltr className="whitespace-nowrap">{r.effectiveTo}</Ltr>
                  ) : (
                    t('prices.history.open')
                  )}
                </span>
              </div>
              <p className="mt-1 text-xs text-muted">
                <bdi>{sup(r.supplierId)}</bdi> · <bdi>{r.enteredBy ?? '–'}</bdi> ·{' '}
                <bdi>{f.dateTime(r.createdAt)}</bdi>
                {r.supersededAt ? ` · ${t('prices.history.corrected')}` : ''}
              </p>
              {r.reason && <p className="mt-1 text-xs">{r.reason}</p>}
            </li>
          ))}
        </ol>
      </SheetContent>
    </Dialog>
  );
}

function Shell({
  title,
  hint,
  onClose,
  children,
  testId,
}: {
  title: string;
  hint?: string;
  onClose: () => void;
  children: React.ReactNode;
  testId: string;
}) {
  const { t } = useTranslation();
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent closeLabel={t('ui.close')} className="max-w-xl" data-testid={testId}>
        <DialogTitle className="mb-1 text-lg font-semibold text-heading">{title}</DialogTitle>
        <DialogDescription className="mb-4 text-sm text-muted">{hint}</DialogDescription>
        {children}
      </DialogContent>
    </Dialog>
  );
}

const useRefresh = () => {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: ['prices'] });
};

export function BulkDialog({ matrix, onClose }: { matrix: Matrix; onClose: () => void }) {
  const { t } = useTranslation();
  const { lang } = usePrefs();
  const f = useFormat();
  const refresh = useRefresh();
  const [percent, setPercent] = useState('0');
  const [plant, setPlant] = useState(ALL);
  const [reason, setReason] = useState('');
  const body = {
    percent: percent.trim(),
    ...(plant !== ALL && { plantIds: [plant] }),
    ...(reason.trim() && { reason: reason.trim() }),
  };
  const valid = /^-?\d{1,4}(\.\d{1,3})?$/.test(percent.trim());
  const preview = useQuery({
    queryKey: ['prices', 'bulk-preview', body],
    queryFn: () => bulkPreview(body),
    enabled: valid,
    retry: false,
  });
  const apply = useMutation({
    mutationFn: () => bulkApply(body),
    onSuccess: async (r) => {
      await refresh();
      toast.success(t('prices.bulk.done', { count: r.applied }));
      onClose();
    },
  });
  return (
    <Shell
      testId="bulk-dialog"
      title={t('prices.bulk.title')}
      hint={t('prices.bulk.hint')}
      onClose={onClose}
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1">
          <Label htmlFor="b-pct">{t('prices.bulk.percent')}</Label>
          <div className="flex items-center gap-2">
            <Input
              id="b-pct"
              dir="ltr"
              inputMode="decimal"
              value={percent}
              onChange={(e) => setPercent(e.target.value)}
              aria-invalid={!valid}
              data-testid="bulk-percent"
            />
            <Ltr className="text-sm text-muted">%</Ltr>
          </div>
          <p className="text-xs text-muted">{t('prices.bulk.zero')}</p>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="b-plant">{t('prices.col.plant')}</Label>
          <Select value={plant} onValueChange={setPlant}>
            <SelectTrigger id="b-plant" aria-label={t('prices.col.plant')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>{t('prices.bulk.allPlants')}</SelectItem>
              {matrix.plants.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {lang === 'ar' ? p.nameAr : p.nameEn}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      <div className="mt-3 flex flex-col gap-1">
        <Label htmlFor="b-reason">{t('prices.reason')}</Label>
        <Input
          id="b-reason"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder={t('prices.reasonPlaceholder')}
        />
      </div>
      <p className="mt-4 text-sm" data-testid="bulk-count" aria-live="polite">
        {preview.isLoading
          ? t('ui.loading')
          : preview.data
            ? t('prices.bulk.preview', { count: preview.data.count })
            : preview.isError
              ? msg(preview.error, '')
              : ''}
      </p>
      {preview.data && preview.data.rows.length > 0 && (
        <ul className="mt-2 max-h-40 overflow-auto text-xs text-muted">
          {preview.data.rows.slice(0, 5).map((r) => (
            <li key={`${r.materialId}${r.plantId}`}>
              <Ltr>
                {r.from ? f.number(Number(r.from), { minimumFractionDigits: 3 }) : '–'} →{' '}
                {f.number(Number(r.to), { minimumFractionDigits: 3 })}
              </Ltr>
            </li>
          ))}
        </ul>
      )}
      {apply.error && (
        <p role="alert" className="mt-2 text-sm text-fail-text">
          {msg(apply.error, t('errors.network'))}
        </p>
      )}
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="secondary" onClick={onClose}>
          {t('rules.cancel')}
        </Button>
        <Button
          disabled={!valid || !preview.data || preview.data.count === 0 || apply.isPending}
          onClick={() => apply.mutate()}
          data-testid="bulk-apply"
        >
          {t('prices.bulk.apply')}
        </Button>
      </div>
    </Shell>
  );
}

export function CopyDialog({ matrix, onClose }: { matrix: Matrix; onClose: () => void }) {
  const { t } = useTranslation();
  const { lang } = usePrefs();
  const refresh = useRefresh();
  const [from, setFrom] = useState(matrix.plants[0]?.id ?? '');
  const [to, setTo] = useState(matrix.plants[1]?.id ?? '');
  const [overwrite, setOverwrite] = useState(false);
  const copy = useMutation({
    mutationFn: () => copyPrices({ fromPlantId: from, toPlantId: to, overwrite }),
    onSuccess: async (r) => {
      await refresh();
      toast.success(t('prices.copy.done', { count: r.applied }));
      onClose();
    },
  });
  const sel = (id: string, value: string, set: (v: string) => void, label: string) => (
    <div className="flex flex-col gap-1">
      <Label htmlFor={id}>{label}</Label>
      <Select value={value} onValueChange={set}>
        <SelectTrigger id={id} aria-label={label}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {matrix.plants.map((p) => (
            <SelectItem key={p.id} value={p.id}>
              {lang === 'ar' ? p.nameAr : p.nameEn}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
  return (
    <Shell
      testId="copy-dialog"
      title={t('prices.copy.title')}
      hint={t('prices.copy.hint')}
      onClose={onClose}
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {sel('c-from', from, setFrom, t('prices.copy.from'))}
        {sel('c-to', to, setTo, t('prices.copy.to'))}
      </div>
      <label className="mt-4 flex items-center gap-2 text-sm">
        <Checkbox checked={overwrite} onCheckedChange={(c) => setOverwrite(c === true)} />
        {t('prices.copy.overwrite')}
      </label>
      {copy.error && (
        <p role="alert" className="mt-2 text-sm text-fail-text">
          {msg(copy.error, t('errors.network'))}
        </p>
      )}
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="secondary" onClick={onClose}>
          {t('rules.cancel')}
        </Button>
        <Button
          disabled={!from || !to || from === to || copy.isPending}
          onClick={() => copy.mutate()}
          data-testid="copy-apply"
        >
          {t('prices.copy.apply')}
        </Button>
      </div>
    </Shell>
  );
}

export function ImportDialog({ matrix, onClose }: { matrix: Matrix; onClose: () => void }) {
  const { t } = useTranslation();
  const { lang } = usePrefs();
  const refresh = useRefresh();
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const load = useMutation({
    mutationFn: (file: File) => previewImport(file),
    onSuccess: (p) => {
      setPreview(p);
      setError(null);
    },
    onError: (e) => {
      setPreview(null);
      setError(msg(e, t('errors.network')));
    },
  });
  const commit = useMutation({
    mutationFn: () => commitImport(preview!.batchId),
    onSuccess: async (r) => {
      await refresh();
      toast.success(t('prices.import.done', { count: r.applied }));
      onClose();
    },
    onError: (e) => setError(msg(e, t('errors.network'))),
  });
  const name = (id: string) => {
    const m = matrix.materials.find((x) => x.id === id);
    return m ? (lang === 'ar' ? (m.marketNameAr ?? m.marketNameEn) : m.marketNameEn) : id;
  };
  return (
    <Shell
      testId="import-dialog"
      title={t('prices.import.title')}
      hint={t('prices.import.hint')}
      onClose={onClose}
    >
      <Label htmlFor="imp-file">{t('prices.import.file')}</Label>
      <input
        ref={input}
        id="imp-file"
        type="file"
        accept=".xlsx,.csv,text/csv"
        data-testid="import-file"
        className="mt-1 text-sm file:me-3 file:rounded-md file:border file:border-line file:bg-surface file:px-3 file:py-1.5 file:text-sm"
        onChange={(e) => e.target.files?.[0] && load.mutate(e.target.files[0])}
      />
      <p className="mt-2 text-xs text-muted">{t('prices.import.columns')}</p>
      {error && (
        <p role="alert" className="mt-3 text-sm text-fail-text" data-testid="import-error">
          {error}
        </p>
      )}
      {preview && (
        <>
          <p className="mt-4 text-sm" data-testid="import-summary">
            {t('prices.import.summary', preview.summary)}
          </p>
          <div className="mt-2 max-h-56 overflow-auto rounded-md border border-line">
            <table className="w-full text-xs" data-testid="import-rows">
              <caption className="sr-only">{t('prices.import.title')}</caption>
              <thead>
                <tr className="text-muted">
                  <th scope="col" className="p-2 text-start font-medium">
                    {t('prices.import.line')}
                  </th>
                  <th scope="col" className="p-2 text-start font-medium">
                    {t('prices.col.material')}
                  </th>
                  <th scope="col" className="p-2 text-start font-medium">
                    {t('prices.import.result')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {preview.rows.map((r) => (
                  <tr key={r.line} className="border-t border-line" data-status={r.status}>
                    <td className="p-2">
                      <Ltr>{r.line}</Ltr>
                    </td>
                    <td className="p-2">
                      {r.entry ? (
                        <>
                          {name(r.entry.materialId)}{' '}
                          <Ltr>
                            {r.entry.price} {r.entry.unit}
                          </Ltr>
                        </>
                      ) : (
                        '–'
                      )}
                    </td>
                    <td
                      className={`p-2 ${r.status === 'error' ? 'text-fail-text' : r.status === 'unchanged' ? 'text-muted' : 'text-pass-text'}`}
                    >
                      {r.status === 'error'
                        ? r.errors
                            .map((c) => t(`prices.importErr.${c}`, { defaultValue: c }))
                            .join(', ')
                        : t(`prices.import.status.${r.status}`)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="secondary" onClick={onClose}>
          {t('rules.cancel')}
        </Button>
        <Button
          disabled={
            !preview || preview.summary.errors > 0 || preview.summary.ok === 0 || commit.isPending
          }
          onClick={() => commit.mutate()}
          data-testid="import-commit"
        >
          {t('prices.import.commit')}
        </Button>
      </div>
    </Shell>
  );
}

export function SnapshotDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const f = useFormat();
  const refresh = useRefresh();
  const list = useQuery(snapshotsQuery);
  const [name, setName] = useState('');
  const create = useMutation({
    mutationFn: () => createSnapshot(name.trim()),
    onSuccess: async () => {
      await refresh();
      toast.success(t('prices.snapshot.done'));
      setName('');
    },
  });
  return (
    <Shell
      testId="snapshot-dialog"
      title={t('prices.snapshot.title')}
      hint={t('prices.snapshot.hint')}
      onClose={onClose}
    >
      <div className="flex items-end gap-2">
        <div className="flex grow flex-col gap-1">
          <Label htmlFor="s-name">{t('prices.snapshot.name')}</Label>
          <Input
            id="s-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            data-testid="snapshot-name"
          />
        </div>
        <Button
          disabled={!name.trim() || create.isPending}
          onClick={() => create.mutate()}
          data-testid="snapshot-create"
        >
          {t('prices.snapshot.create')}
        </Button>
      </div>
      {create.error && (
        <p role="alert" className="mt-2 text-sm text-fail-text">
          {msg(create.error, t('errors.network'))}
        </p>
      )}
      <ul className="mt-4 flex max-h-56 flex-col gap-2 overflow-auto" data-testid="snapshot-list">
        {(list.data ?? []).map((s) => (
          <li key={s.id} className="rounded-md border border-line p-2 text-sm">
            <strong>{s.name}</strong>
            <span className="block text-xs text-muted">
              <Ltr>{s.asOf}</Ltr> · {t('prices.snapshot.lines', { count: s.lineCount })} ·{' '}
              {f.dateTime(s.createdAt)}
            </span>
            <Ltr mono className="text-[0.65rem] text-muted">
              {s.contentHash.slice(0, 16)}
            </Ltr>
          </li>
        ))}
      </ul>
    </Shell>
  );
}

/** Asks which supplier to use for cells whose supplier cannot be inferred, then resubmits. */
export function SupplierDialog({
  matrix,
  count,
  onChoose,
  onClose,
}: {
  matrix: Matrix;
  count: number;
  onChoose: (supplierId: string) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { lang } = usePrefs();
  const [s, setS] = useState(matrix.suppliers[0]?.id ?? '');
  return (
    <Shell
      testId="supplier-dialog"
      title={t('prices.supplier.title')}
      hint={t('prices.supplier.hint', { count })}
      onClose={onClose}
    >
      <Label htmlFor="sup-pick">{t('materials.col.supplier')}</Label>
      <Select value={s} onValueChange={setS}>
        <SelectTrigger id="sup-pick" aria-label={t('materials.col.supplier')}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {matrix.suppliers.map((x) => (
            <SelectItem key={x.id} value={x.id}>
              {lang === 'ar' ? x.nameAr : x.nameEn}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="secondary" onClick={onClose}>
          {t('rules.cancel')}
        </Button>
        <Button disabled={!s} onClick={() => onChoose(s)} data-testid="supplier-confirm">
          {t('prices.supplier.use')}
        </Button>
      </div>
    </Shell>
  );
}
