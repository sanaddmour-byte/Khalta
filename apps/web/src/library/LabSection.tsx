import {
  Button,
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
  toast,
} from '@khalta/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../lib/api';
import { useMe } from '../lib/auth';
import { useFormat } from '../lib/format';
import { usePrefs } from '../lib/prefs';
import type { DesignCard, DesignLine } from './api';
import {
  addBatch,
  addResults,
  downloadSubmittal,
  instancesQuery,
  labQuery,
  previewBatch,
  saveBatch,
  type BatchResult,
  type Preview,
} from './labApi';
import { exportBatch } from '../exports/api';
import { BatchPlanPanel } from './BatchPlanPanel';
import { StrengthChart } from './StrengthChart';

const TRIAL = ['trial_candidate', 'trial_in_progress'];
const CONVERT = [...TRIAL, 'approved', 'in_production'];
const today = () => new Date().toISOString().slice(0, 10);
const numOrUndef = (s: string) =>
  s.trim() === '' || !Number.isFinite(Number(s)) ? undefined : Number(s);

function BatchDialog({ design, onClose }: { design: DesignCard; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [f, setF] = useState({
    batchedOn: today(),
    slumpMm: '',
    airPct: '',
    temperatureC: '',
    freshDensityKgM3: '',
    yieldM3: '',
    waterAddedKgM3: '',
    retainedSlumpMm: '',
    retentionMinutes: '',
    stability: '',
    placement: '',
    notes: '',
  });
  const m = useMutation({
    mutationFn: () =>
      addBatch(design.id, {
        batchedOn: f.batchedOn,
        slumpMm: numOrUndef(f.slumpMm),
        airPct: numOrUndef(f.airPct),
        temperatureC: numOrUndef(f.temperatureC),
        freshDensityKgM3: numOrUndef(f.freshDensityKgM3),
        yieldM3: numOrUndef(f.yieldM3),
        waterAddedKgM3: numOrUndef(f.waterAddedKgM3),
        retainedSlumpMm: numOrUndef(f.retainedSlumpMm),
        retentionMinutes: numOrUndef(f.retentionMinutes),
        ...(f.stability && { stability: f.stability }),
        ...(f.placement && { placementAcceptable: f.placement === 'yes' }),
        ...(f.notes.trim() && { notes: f.notes.trim() }),
      }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['designs'] });
      toast.success(t('lab.saved'));
      onClose();
    },
  });
  const fields: [keyof typeof f, string][] = [
    ['slumpMm', 'lab.batch.slump'],
    ['airPct', 'lab.batch.air'],
    ['temperatureC', 'lab.batch.temperature'],
    ['freshDensityKgM3', 'lab.batch.density'],
    ['yieldM3', 'lab.batch.yield'],
    ['waterAddedKgM3', 'lab.batch.waterAdded'],
    ['retainedSlumpMm', 'lab.batch.retainedSlump'],
    ['retentionMinutes', 'lab.batch.retentionMinutes'],
  ];
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent closeLabel={t('ui.close')} className="max-w-xl" data-testid="batch-dialog">
        <DialogTitle className="mb-1 text-lg font-semibold text-heading">
          {t('lab.batch.add')}
        </DialogTitle>
        <DialogDescription className="mb-4 text-sm text-muted">
          {t('lab.batch.hint')}
        </DialogDescription>
        <div className="grid grid-cols-2 gap-3">
          <div className="flex flex-col gap-1">
            <Label htmlFor="b-date">{t('lab.batch.date')}</Label>
            <Input
              id="b-date"
              type="date"
              dir="ltr"
              value={f.batchedOn}
              onChange={(e) => setF({ ...f, batchedOn: e.target.value })}
              data-testid="batch-date"
            />
          </div>
          {fields.map(([k, label]) => (
            <div key={k} className="flex flex-col gap-1">
              <Label htmlFor={`b-${k}`}>{t(label)}</Label>
              <Input
                id={`b-${k}`}
                dir="ltr"
                inputMode="decimal"
                value={f[k]}
                onChange={(e) => setF({ ...f, [k]: e.target.value })}
                data-testid={`batch-${k}`}
              />
            </div>
          ))}
          <div className="flex flex-col gap-1">
            <Label htmlFor="b-stability">{t('lab.batch.stability')}</Label>
            <select
              id="b-stability"
              className="h-9 rounded-md border border-line bg-surface px-2 text-sm"
              value={f.stability}
              onChange={(e) => setF({ ...f, stability: e.target.value })}
              data-testid="batch-stability"
            >
              <option value="">{t('lab.batch.notObserved')}</option>
              {['stable', 'bleeding', 'segregation', 'bleeding_and_segregation'].map((v) => (
                <option key={v} value={v}>
                  {t(`lab.batch.stabilityOptions.${v}`)}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="b-placement">{t('lab.batch.placement')}</Label>
            <select
              id="b-placement"
              className="h-9 rounded-md border border-line bg-surface px-2 text-sm"
              value={f.placement}
              onChange={(e) => setF({ ...f, placement: e.target.value })}
              data-testid="batch-placement"
            >
              <option value="">{t('lab.batch.notObserved')}</option>
              <option value="yes">{t('lab.batch.placementYes')}</option>
              <option value="no">{t('lab.batch.placementNo')}</option>
            </select>
          </div>
          <p className="col-span-2 text-xs text-muted">{t('lab.batch.optionalHint')}</p>
          <div className="col-span-2 flex flex-col gap-1">
            <Label htmlFor="b-notes">{t('lab.batch.notes')}</Label>
            <Input
              id="b-notes"
              value={f.notes}
              onChange={(e) => setF({ ...f, notes: e.target.value })}
            />
          </div>
        </div>
        {m.error instanceof ApiError && (
          <p role="alert" className="mt-3 text-sm text-fail-text">
            {m.error.message}
          </p>
        )}
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            {t('rules.cancel')}
          </Button>
          <Button
            disabled={!f.batchedOn || m.isPending}
            onClick={() => m.mutate()}
            data-testid="batch-save"
          >
            {t('lab.save')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ResultsDialog({
  batchId,
  ageDays,
  onClose,
}: {
  batchId: string;
  ageDays: number | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [f, setF] = useState({
    castDate: today(),
    ageDays: String(ageDays ?? 28),
    type: 'cylinder',
    setId: '',
    results: '',
  });
  const values = f.results
    .split(/[\s,;]+/)
    .filter(Boolean)
    .map(Number);
  const valid =
    values.length > 0 &&
    values.every((v) => Number.isFinite(v) && v >= 0) &&
    f.setId.trim() &&
    Number(f.ageDays) > 0;
  const m = useMutation({
    mutationFn: () =>
      addResults(batchId, {
        castDate: f.castDate,
        ageDays: Number(f.ageDays),
        specimenType: f.type,
        setId: f.setId.trim(),
        resultsMpa: values,
      }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['designs'] });
      toast.success(t('lab.saved'));
      onClose();
    },
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent closeLabel={t('ui.close')} className="max-w-xl" data-testid="results-dialog">
        <DialogTitle className="mb-1 text-lg font-semibold text-heading">
          {t('lab.results.add')}
        </DialogTitle>
        <DialogDescription className="mb-4 text-sm text-muted">
          {t('lab.results.hint', { age: ageDays ?? '–' })}
        </DialogDescription>
        <div className="grid grid-cols-2 gap-3">
          <div className="flex flex-col gap-1">
            <Label htmlFor="r-cast">{t('lab.results.cast')}</Label>
            <Input
              id="r-cast"
              type="date"
              dir="ltr"
              value={f.castDate}
              onChange={(e) => setF({ ...f, castDate: e.target.value })}
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="r-age">{t('lab.results.age')}</Label>
            <Input
              id="r-age"
              dir="ltr"
              inputMode="numeric"
              value={f.ageDays}
              onChange={(e) => setF({ ...f, ageDays: e.target.value })}
              data-testid="results-age"
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="r-type">{t('lab.results.type')}</Label>
            <Select value={f.type} onValueChange={(v) => setF({ ...f, type: v })}>
              <SelectTrigger id="r-type">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="cylinder">{t('lab.results.cylinder')}</SelectItem>
                <SelectItem value="cube">{t('lab.results.cube')}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="r-set">{t('lab.results.set')}</Label>
            <Input
              id="r-set"
              dir="ltr"
              value={f.setId}
              onChange={(e) => setF({ ...f, setId: e.target.value })}
              data-testid="results-set"
            />
          </div>
          <div className="col-span-2 flex flex-col gap-1">
            <Label htmlFor="r-vals">{t('lab.results.values')}</Label>
            <Input
              id="r-vals"
              dir="ltr"
              placeholder="38.5, 39.1, 40.2"
              value={f.results}
              onChange={(e) => setF({ ...f, results: e.target.value })}
              data-testid="results-values"
            />
          </div>
        </div>
        {m.error instanceof ApiError && (
          <p role="alert" className="mt-3 text-sm text-fail-text">
            {m.error.message}
          </p>
        )}
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            {t('rules.cancel')}
          </Button>
          <Button
            disabled={!valid || m.isPending}
            onClick={() => m.mutate()}
            data-testid="results-save"
          >
            {t('lab.save')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ConversionView({ r }: { r: BatchResult }) {
  const { t } = useTranslation();
  const f = useFormat();
  if (!r.ok)
    return (
      <ul className="flex flex-col gap-1 text-sm text-fail-text" data-testid="batch-blockers">
        {r.blockers.map((b, i) => (
          <li key={i}>
            {t(`lab.blocker.${b.code}`, { defaultValue: b.code })} ·{' '}
            <Ltr>{b.subject.length > 20 ? b.subject.slice(0, 8) : b.subject}</Ltr>
            <span className="block text-xs">{b.detail}</span>
          </li>
        ))}
      </ul>
    );
  const n = (v: number | null) =>
    v === null ? '–' : f.number(v, { minimumFractionDigits: 1, maximumFractionDigits: 3 });
  return (
    <div className="flex flex-col gap-2" data-testid="batch-result">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-muted">
            <th scope="col" className="py-1 text-start font-medium">
              {t('library.line.material')}
            </th>
            <th scope="col" className="py-1 text-start font-medium">
              {t('lab.batch.ssd')}
            </th>
            <th scope="col" className="py-1 text-start font-medium">
              {t('lab.batch.free')}
            </th>
            <th scope="col" className="py-1 text-start font-medium">
              {t('lab.batch.weigh')}
            </th>
          </tr>
        </thead>
        <tbody>
          {r.lines.map((l) => (
            <tr key={l.materialId} className="border-t border-line">
              <td className="py-1.5">{t(`materials.category.${l.category}`)}</td>
              <td className="py-1.5">
                <Ltr>{n(l.kgSsd)}</Ltr>
              </td>
              <td className="py-1.5">
                <Ltr>{n(l.freeWaterKg)}</Ltr>
              </td>
              <td className="py-1.5 font-semibold">
                <Ltr>{n(l.kgBatch)}</Ltr>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-sm" data-testid="batch-water">
        {t('lab.batch.waterLine', {
          design: n(r.designWaterKg),
          free: n(r.freeWaterFromAggregatesKg),
          batch: n(r.batchWaterKg),
        })}
      </p>
      <p className="text-xs text-muted">
        {t('lab.batch.balance', { ssd: n(r.balance.ssdTotalKg), batch: n(r.balance.batchTotalKg) })}{' '}
        {r.convention.admixtureSolutionWater
          ? t('lab.batch.solutionOn', { kg: n(r.solutionWaterSubtractedKg) })
          : t('lab.batch.solutionOff')}
      </p>
    </div>
  );
}

function BatchWeights({ design, lines }: { design: DesignCard; lines: DesignLine[] }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { lang } = usePrefs();
  const aggs = lines.filter((l) => l.category.endsWith('_agg'));
  const [vals, setVals] = useState<Record<string, string>>({});
  const rows = aggs.flatMap((a) =>
    vals[a.materialId] !== undefined &&
    vals[a.materialId] !== '' &&
    Number.isFinite(Number(vals[a.materialId]))
      ? [{ materialId: a.materialId, totalMoisturePct: Number(vals[a.materialId]) }]
      : [],
  );
  const [preview, setPreview] = useState<Preview | null>(null);
  const prev = useMutation({
    mutationFn: () => previewBatch(design.id, rows),
    onSuccess: setPreview,
  });
  const save = useMutation({
    mutationFn: () => saveBatch(design.id, rows),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['designs'] });
      toast.success(t('lab.saved'));
    },
  });
  const inst = useQuery(instancesQuery(design.id));
  const f = useFormat();
  const { data: me } = useMe();
  const caps = me?.capabilities ?? [];
  const err =
    (save.error ?? prev.error) instanceof ApiError
      ? ((save.error ?? prev.error) as ApiError).message
      : null;
  return (
    <section className="mt-6" aria-label={t('lab.weights.title')} data-testid="batch-weights">
      <h3 className="mb-1 text-sm font-semibold text-heading">{t('lab.weights.title')}</h3>
      <p className="mb-2 text-xs text-muted">{t('lab.weights.hint')}</p>
      <div className="flex flex-wrap gap-3">
        {aggs.map((a) => (
          <div key={a.materialId} className="flex flex-col gap-1">
            <Label htmlFor={`m-${a.materialId}`}>
              {lang === 'ar' ? (a.nameAr ?? a.nameEn) : a.nameEn}
            </Label>
            <Input
              id={`m-${a.materialId}`}
              className="w-32"
              dir="ltr"
              inputMode="decimal"
              placeholder={t('lab.weights.moisture')}
              value={vals[a.materialId] ?? ''}
              onChange={(e) => setVals({ ...vals, [a.materialId]: e.target.value })}
              data-testid={`moisture-${a.category}`}
            />
          </div>
        ))}
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button
          variant="secondary"
          onClick={() => prev.mutate()}
          disabled={prev.isPending}
          data-testid="batch-convert"
        >
          {t('lab.weights.convert')}
        </Button>
        {preview?.result.ok && preview.validator.status === 'pass' && (
          <Button onClick={() => save.mutate()} disabled={save.isPending} data-testid="batch-store">
            {t('lab.weights.store')}
          </Button>
        )}
      </div>
      {err && (
        <p role="alert" className="mt-2 text-sm text-fail-text">
          {err}
        </p>
      )}
      {preview && (
        <div className="mt-3 rounded-md border border-line p-3">
          <ConversionView r={preview.result} />
          {preview.result.ok && (
            <p
              className={`mt-2 text-sm ${preview.validator.status === 'pass' ? 'text-pass-text' : 'text-fail-text'}`}
              data-testid="batch-validator"
              data-status={preview.validator.status}
            >
              {t(`lab.weights.validator.${preview.validator.status}`)}
            </p>
          )}
        </div>
      )}
      {inst.data && inst.data.length > 0 && (
        <ul className="mt-3 flex flex-col gap-1 text-sm" data-testid="batch-history">
          {inst.data.map((i) => (
            <li key={i.id} className="rounded-md border border-line p-2">
              {t(`lab.weights.kind.${i.kind}`)} · {i.actor ?? '–'} · {f.dateTime(i.createdAt)}
              {i.result.ok && (
                <>
                  {' '}
                  ·{' '}
                  {t('lab.weights.batchWater', {
                    kg: f.number(i.result.batchWaterKg, { maximumFractionDigits: 1 }),
                  })}
                </>
              )}
              {i.kind === 'production' &&
                ['approved', 'in_production'].includes(design.status) &&
                caps.includes('export.csv') && (
                  <Button
                    variant="ghost"
                    className="ms-2"
                    onClick={() =>
                      exportBatch(i.id)
                        .then((name) => toast.success(t('exports.done', { name })))
                        .catch(() => toast.error(t('exports.failed')))
                    }
                    data-testid="export-batch"
                  >
                    {t('exports.batch')}
                  </Button>
                )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Lab loop (F-023, F-024) and the PDF submittal (F-025) on the design sheet. */
export function LabSection({ design, lines }: { design: DesignCard; lines: DesignLine[] }) {
  const { t } = useTranslation();
  const { lang } = usePrefs();
  const { data: me } = useMe();
  const caps = me?.capabilities ?? [];
  const canEnter = caps.includes('lab.enter');
  const lab = useQuery(labQuery(design.id));
  const [batchOpen, setBatchOpen] = useState(false);
  const [resultsFor, setResultsFor] = useState<string | null>(null);
  const [pdfLang, setPdfLang] = useState<'en' | 'ar' | 'both'>(lang === 'ar' ? 'ar' : 'en');
  const pdf = useMutation({ mutationFn: () => downloadSubmittal(design.id, design.code, pdfLang) });
  const batches = lab.data?.batches ?? [];
  const age = lab.data?.testAgeDays ?? null;
  const atAge = (lab.data?.results ?? []).filter((r) => r.ageDays === age);
  const ordered = [...atAge].sort(
    (a, b) => a.castDate.localeCompare(b.castDate) || a.setId.localeCompare(b.setId),
  );
  const f = useFormat();
  const show = TRIAL.includes(design.status) || batches.length > 0;
  return (
    <>
      {show && (
        <section className="mt-6" aria-label={t('lab.batches.title')} data-testid="trial-batches">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-heading">{t('lab.batches.title')}</h3>
            {canEnter && TRIAL.includes(design.status) && (
              <Button
                variant="secondary"
                onClick={() => setBatchOpen(true)}
                data-testid="batch-add"
              >
                {t('lab.batch.add')}
              </Button>
            )}
          </div>
          {batches.length === 0 ? (
            <p className="text-sm text-muted">{t('lab.batches.none')}</p>
          ) : (
            <table className="w-full text-sm" data-testid="batch-table">
              <thead>
                <tr className="text-muted">
                  {['date', 'slump', 'air', 'temperature', 'density', 'yield'].map((k) => (
                    <th key={k} scope="col" className="py-1 text-start font-medium">
                      {t(`lab.batch.${k}`)}
                    </th>
                  ))}
                  <th scope="col" className="py-1 text-start font-medium">
                    {t('lab.batches.specimens', { age: age ?? '–' })}
                  </th>
                  <th scope="col" className="py-1">
                    <span className="sr-only">{t('lab.results.add')}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {batches.map((b) => {
                  const mine = atAge
                    .filter((r) => r.trialBatchId === b.id)
                    .map((r) => Number(r.resultMpa));
                  return (
                    <tr key={b.id} className="border-t border-line" data-testid="batch-row">
                      <td className="py-1.5">
                        <Ltr>{b.batchedOn}</Ltr>
                      </td>
                      {[b.slumpMm, b.airPct, b.temperatureC, b.freshDensityKgM3, b.yieldM3].map(
                        (v, i) => (
                          <td key={i} className="py-1.5">
                            <Ltr>
                              {v === null ? '–' : f.number(Number(v), { maximumFractionDigits: 3 })}
                            </Ltr>
                          </td>
                        ),
                      )}
                      <td className="py-1.5">
                        <Ltr>{mine.length ? mine.join(', ') : '–'}</Ltr>
                      </td>
                      <td className="py-1.5">
                        {canEnter && TRIAL.includes(design.status) && (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => setResultsFor(b.id)}
                            data-testid="results-add"
                          >
                            {t('lab.results.add')}
                          </Button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          {ordered.length > 0 && (
            <div className="mt-3">
              <h4 className="mb-1 text-xs font-medium text-muted">{t('lab.chart.title')}</h4>
              <StrengthChart
                values={ordered.map((r) => Number(r.resultMpa))}
                fc={lab.data?.fcMpa ?? null}
                fcr={lab.data?.fcrMpa ?? null}
              />
            </div>
          )}
        </section>
      )}
      {canEnter && CONVERT.includes(design.status) && (
        <>
          <BatchWeights design={design} lines={lines} />
          <BatchPlanPanel design={design} lines={lines} />
        </>
      )}
      <section
        className="mt-6 flex flex-wrap items-end gap-2"
        aria-label={t('lab.pdf.title')}
        data-testid="submittal"
      >
        <div className="flex flex-col gap-1">
          <Label htmlFor="pdf-lang">{t('lab.pdf.language')}</Label>
          <Select value={pdfLang} onValueChange={(v) => setPdfLang(v as 'en' | 'ar' | 'both')}>
            <SelectTrigger id="pdf-lang" className="w-44" data-testid="pdf-lang">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="en">{t('lab.pdf.en')}</SelectItem>
              <SelectItem value="ar">{t('lab.pdf.ar')}</SelectItem>
              <SelectItem value="both">{t('lab.pdf.both')}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <Button
          variant="secondary"
          onClick={() => pdf.mutate()}
          disabled={pdf.isPending}
          data-testid="pdf-download"
        >
          {t('lab.pdf.download')}
        </Button>
        {!['approved', 'in_production'].includes(design.status) && (
          <p className="basis-full text-xs text-warn-text">{t('lab.pdf.watermark')}</p>
        )}
        {pdf.error instanceof ApiError && (
          <p role="alert" className="basis-full text-sm text-fail-text">
            {pdf.error.message}
          </p>
        )}
      </section>
      {batchOpen && <BatchDialog design={design} onClose={() => setBatchOpen(false)} />}
      {resultsFor && (
        <ResultsDialog batchId={resultsFor} ageDays={age} onClose={() => setResultsFor(null)} />
      )}
    </>
  );
}
