import {
  Button,
  Ltr,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  toast,
} from '@khalta/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { CircleAlert, CircleCheck, TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../lib/api';
import { useMe } from '../lib/auth';
import { SectionPage } from '../pages/Section';
import {
  COLUMNS,
  REQUIRED,
  commitLegacy,
  previewLegacy,
  uploadLegacy,
  type Decisions,
  type Mapping,
  type Plan,
  type Upload,
} from './api';

const NONE = '__none';
const CREATE = '__create';
const AUTO = '__auto';

export function ImportsPage() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { data: me } = useMe();
  const canImport = (me?.capabilities ?? []).includes('import.run');
  const [up, setUp] = useState<Upload | null>(null);
  const [mapping, setMapping] = useState<Mapping>({});
  const [decisions, setDecisions] = useState<Decisions>({});
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ designs: number; createdMaterials: number } | null>(null);

  const upload = useMutation({
    mutationFn: (file: File) => uploadLegacy(file),
    onSuccess: (u) => {
      setUp(u);
      setMapping(u.mapping);
      setDecisions({});
      setError(null);
      setDone(null);
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : t('errors.network')),
  });
  const plan = useQuery({
    queryKey: ['legacy-plan', up?.batchId, mapping, decisions],
    queryFn: () => previewLegacy(up!.batchId, mapping, decisions),
    enabled: !!up,
    retry: false,
  });
  const commit = useMutation({
    mutationFn: () => commitLegacy(up!.batchId, mapping, decisions),
    onSuccess: async (r) => {
      setDone(r);
      setUp(null);
      await qc.invalidateQueries({ queryKey: ['designs'] });
      await qc.invalidateQueries({ queryKey: ['materials'] });
      toast.success(t('imports.done', { count: r.designs }));
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : t('errors.network')),
  });

  if (me && !canImport) return <SectionPage id="imports" />;
  const p: Plan | undefined = plan.data;
  const blocked =
    !p ||
    p.missing.length > 0 ||
    p.fileErrors.length > 0 ||
    p.summary.errors > 0 ||
    p.summary.designs === 0;

  const choose = (key: string, value: string) =>
    setDecisions((d) => ({
      ...d,
      [key]: value === AUTO ? null : value === CREATE ? { create: true } : { materialId: value },
    }));
  const valueOf = (key: string) => {
    const dec = decisions[key];
    if (dec && 'create' in dec) return CREATE;
    if (dec && 'materialId' in dec) return dec.materialId;
    return AUTO;
  };

  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="text-2xl font-semibold text-heading">{t('nav.imports')}</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted">{t('imports.intro')}</p>
      </header>

      {done && (
        <p
          role="status"
          className="flex items-center gap-2 rounded-md bg-pass-bg p-3 text-sm text-pass-text"
          data-testid="import-done"
        >
          <CircleCheck className="size-4" aria-hidden />
          {t('imports.done', { count: done.designs })}{' '}
          <Link to="/library" className="underline">
            {t('imports.openLibrary')}
          </Link>
        </p>
      )}

      <section
        className="rounded-lg border border-line bg-surface p-4"
        aria-label={t('imports.step1')}
      >
        <h2 className="mb-1 text-base font-semibold text-heading">{t('imports.step1')}</h2>
        <p className="mb-3 text-sm text-muted">{t('imports.fileHint')}</p>
        <input
          type="file"
          accept=".xlsx,.csv,text/csv"
          data-testid="legacy-file"
          aria-label={t('imports.step1')}
          className="text-sm file:me-3 file:rounded-md file:border file:border-line file:bg-surface file:px-3 file:py-1.5 file:text-sm"
          onChange={(e) => e.target.files?.[0] && upload.mutate(e.target.files[0])}
        />
        {up && (
          <p className="mt-2 text-xs text-muted">{t('imports.uploaded', { lines: up.lines })}</p>
        )}
        {error && (
          <p role="alert" className="mt-2 text-sm text-fail-text" data-testid="import-error">
            {error}
          </p>
        )}
      </section>

      {up && (
        <section
          className="rounded-lg border border-line bg-surface p-4"
          aria-label={t('imports.step2')}
          data-testid="mapping"
        >
          <h2 className="mb-1 text-base font-semibold text-heading">{t('imports.step2')}</h2>
          <p className="mb-3 text-sm text-muted">{t('imports.mapHint')}</p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {COLUMNS.map((c) => (
              <div key={c} className="flex flex-col gap-1">
                <label htmlFor={`map-${c}`} className="text-xs font-medium text-heading">
                  <Ltr mono>{c}</Ltr>
                  {REQUIRED.includes(c) ? ` · ${t('imports.required')}` : ''}
                </label>
                <Select
                  value={mapping[c] === undefined ? NONE : String(mapping[c])}
                  onValueChange={(v) =>
                    setMapping((m) => {
                      const n = { ...m };
                      if (v === NONE) delete n[c];
                      else n[c] = Number(v);
                      return n;
                    })
                  }
                >
                  <SelectTrigger
                    id={`map-${c}`}
                    aria-label={c}
                    aria-invalid={REQUIRED.includes(c) && mapping[c] === undefined}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE}>{t('imports.notInFile')}</SelectItem>
                    {up.header.map((h, i) => (
                      <SelectItem key={i} value={String(i)}>
                        {h || `#${i + 1}`}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ))}
          </div>
        </section>
      )}

      {up && plan.isLoading && <Skeleton className="h-32 w-full" />}
      {p && p.missing.length === 0 && (
        <section
          className="rounded-lg border border-line bg-surface p-4"
          aria-label={t('imports.step3')}
          data-testid="matching"
        >
          <h2 className="mb-1 text-base font-semibold text-heading">{t('imports.step3')}</h2>
          <p className="mb-3 text-sm text-muted">{t('imports.matchHint')}</p>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <caption className="sr-only">{t('imports.step3')}</caption>
              <thead>
                <tr className="text-muted">
                  <th scope="col" className="p-2 text-start font-medium">
                    {t('imports.col.name')}
                  </th>
                  <th scope="col" className="p-2 text-start font-medium">
                    {t('materials.col.category')}
                  </th>
                  <th scope="col" className="p-2 text-start font-medium">
                    {t('imports.col.link')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {p.materials.map((m) => (
                  <tr
                    key={m.key}
                    className="border-t border-line"
                    data-material={m.name}
                    data-decision={m.decision}
                  >
                    <td className="p-2 align-top">
                      {m.name}
                      <span className="block text-xs text-muted">
                        {t('imports.lines', { n: m.lines })}
                      </span>
                    </td>
                    <td className="p-2 align-top">{t(`materials.category.${m.category}`)}</td>
                    <td className="p-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <Select value={valueOf(m.key)} onValueChange={(v) => choose(m.key, v)}>
                          <SelectTrigger
                            className="w-64 max-w-full"
                            aria-label={t('imports.linkFor', { name: m.name })}
                            data-testid="link-select"
                          >
                            <SelectValue placeholder={t('imports.choose')} />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value={AUTO}>
                              {m.exactId ? t('imports.exactAuto') : t('imports.unresolved')}
                            </SelectItem>
                            {m.suggestions.map((s) => (
                              <SelectItem key={s.id} value={s.id}>
                                {t('imports.suggestion', { name: s.name })}
                              </SelectItem>
                            ))}
                            <SelectItem value={CREATE}>{t('imports.createNew')}</SelectItem>
                          </SelectContent>
                        </Select>
                        <span
                          className={`inline-flex items-center gap-1 text-xs ${m.decision === 'unresolved' ? 'text-fail-text' : 'text-pass-text'}`}
                        >
                          {m.decision === 'unresolved' ? (
                            <CircleAlert className="size-3.5" aria-hidden />
                          ) : (
                            <CircleCheck className="size-3.5" aria-hidden />
                          )}
                          {t(`imports.decision.${m.decision}`)}
                        </span>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {p && p.missing.length === 0 && (
        <section
          className="rounded-lg border border-line bg-surface p-4"
          aria-label={t('imports.step4')}
          data-testid="review"
        >
          <h2 className="mb-1 text-base font-semibold text-heading">{t('imports.step4')}</h2>
          <p className="mb-3 text-sm" data-testid="plan-summary" aria-live="polite">
            {t('imports.summary', p.summary)}
          </p>
          {p.fileErrors.length > 0 && (
            <ul className="mb-3 list-disc ps-5 text-sm text-fail-text">
              {p.fileErrors.map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          )}
          <ul className="flex flex-col gap-3">
            {p.designs.map((d) => (
              <li
                key={d.code}
                className="rounded-md border border-line p-3 text-sm"
                data-design={d.code}
                data-ok={d.errors.length === 0}
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <strong>
                    <Ltr mono>{d.code}</Ltr>
                  </strong>
                  <span className="text-xs text-muted">
                    {d.name} · <Ltr>{d.plantCode}</Ltr> ·{' '}
                    {t('imports.lines', { n: d.lines.length })}
                  </span>
                </div>
                {d.errors.map((e, i) => (
                  <p key={`e${i}`} className="mt-1 flex items-start gap-1 text-xs text-fail-text">
                    <CircleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                    {t(`imports.err.${e.code}`, { defaultValue: e.code })}
                    {e.detail ? ` · ${e.detail}` : ''}
                    {e.line ? ` (${t('imports.lineNo', { n: e.line })})` : ''}
                  </p>
                ))}
                {d.warnings.map((w, i) => (
                  <p key={`w${i}`} className="mt-1 flex items-start gap-1 text-xs text-warn-text">
                    <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                    {t(`library.warn.${w.code}`, { defaultValue: w.code })}
                    {w.detail ? ` · ${w.detail}` : ''}
                  </p>
                ))}
              </li>
            ))}
          </ul>
          <div className="mt-4 flex items-center gap-3">
            <Button
              disabled={blocked || commit.isPending}
              onClick={() => commit.mutate()}
              data-testid="legacy-commit"
            >
              {t('imports.commit')}
            </Button>
            <span className="text-xs text-muted">{t('imports.commitHint')}</span>
          </div>
        </section>
      )}
    </div>
  );
}
