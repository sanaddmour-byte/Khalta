import type { GradationPoint, Source } from '@khalta/engine';
import { fineModulus, DEFAULT_FM_SIEVES } from '@khalta/engine';
import {
  Button,
  Dialog,
  DialogClose,
  DialogDescription,
  DialogTitle,
  Ltr,
  SheetContent,
  Skeleton,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  toast,
} from '@khalta/ui';
import { useQuery } from '@tanstack/react-query';
import { FilePlus2, FileText, ShieldCheck, X } from 'lucide-react';
import { lazy, Suspense, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMe } from '../lib/auth';
import { useFormat } from '../lib/format';
import { usePlant } from '../lib/plant';
import { usePrefs } from '../lib/prefs';
import {
  materialQuery,
  openAttachment,
  paramsQuery,
  testsQuery,
  type Blocker,
  type MaterialTest,
} from './api';
import { FreshnessChip, ReadyChip, SourceChip } from './chips';
import { EntryDialog } from './EntryDialog';
import { fieldsFor } from './fields';
import { Sparkline } from './Sparkline';

const GradationChart = lazy(() => import('./GradationChart'));

function Field({
  label,
  children,
  wide,
}: {
  label: string;
  children: React.ReactNode;
  wide?: boolean;
}) {
  return (
    <div className={`flex flex-col gap-0.5 ${wide ? 'col-span-2' : ''}`}>
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="text-sm">{children}</dd>
    </div>
  );
}

function BlockerList({ blockers, kind }: { blockers: Blocker[]; kind: 'evaluate' | 'design' }) {
  const { t } = useTranslation();
  if (blockers.length === 0) return null;
  return (
    <div data-testid={`blockers-${kind}`}>
      <p className="mb-1 text-xs font-medium text-heading">{t(`materials.blockers.${kind}`)}</p>
      <ul className="flex flex-wrap gap-1.5">
        {blockers.map((b) => (
          <li
            key={b.field}
            className="rounded-md border border-warn bg-warn-bg px-2 py-0.5 text-xs text-warn-text"
          >
            {t(`materials.field.${b.field}`, { defaultValue: b.field })}
            {b.code === 'invalid' ? ` · ${t('materials.blockers.invalid')}` : ''}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function MaterialSheet({ id, onClose }: { id: string | null; onClose: () => void }) {
  const { t } = useTranslation();
  const { lang } = usePrefs();
  const f = useFormat();
  const { data: me } = useMe();
  const { plants } = usePlant();
  const detail = useQuery({ ...materialQuery(id ?? ''), enabled: !!id });
  const history = useQuery({ ...testsQuery(id ?? ''), enabled: !!id });
  const params = useQuery(paramsQuery);
  const [entry, setEntry] = useState<'test' | 'upgrade' | null>(null);
  const caps = me?.capabilities ?? [];
  const canEnter = caps.includes('lab.enter');

  const cur = detail.data?.current ?? null;
  const gradation = (cur?.properties['sieve_analysis'] as GradationPoint[] | undefined) ?? [];
  const asc = useMemo(
    () => [...(history.data ?? [])].sort((a, b) => a.version - b.version),
    [history.data],
  );
  const trend = (key: 'sg_ssd' | 'absorption_pct' | 'fm') =>
    asc
      .map((v) => {
        if (key === 'fm') {
          const g = v.properties['sieve_analysis'] as GradationPoint[] | undefined;
          const r = g ? fineModulus(g, params.data?.fmSieves ?? DEFAULT_FM_SIEVES) : null;
          return r?.ok ? r.fm : null;
        }
        const x = v.properties[key];
        return typeof x === 'number' ? x : null;
      })
      .filter((x): x is number => x !== null);

  if (!id) return null;
  const m = detail.data?.material;
  const s = detail.data?.summary;
  const name = m ? (lang === 'ar' ? (m.marketNameAr ?? m.marketNameEn) : m.marketNameEn) : '';
  const other = m ? (lang === 'ar' ? m.marketNameEn : m.marketNameAr) : null;
  const fields = m ? fieldsFor(m.category) : [];
  const hasDeclared = !!cur && Object.values(cur.fieldSources).some((x) => x !== 'lab_report');
  const plant = plants.find((p) => p.id === m?.plantId);

  const fmt = (v: unknown, d: (typeof fields)[number]) =>
    typeof v === 'number' ? (
      <>
        <Ltr>{f.number(v)}</Ltr>
        {d.unit && <Ltr className="ms-1 text-xs text-muted">{d.unit}</Ltr>}
      </>
    ) : (
      t(`materials.opt.${d.key}.${String(v)}`, { defaultValue: String(v) })
    );

  async function open(tst: MaterialTest) {
    if (!tst.attachmentId) return;
    try {
      await openAttachment(tst.attachmentId);
    } catch {
      toast.error(t('errors.loadFailed'));
    }
  }

  return (
    <>
      <Dialog open onOpenChange={(o) => !o && onClose()}>
        <SheetContent
          side="end"
          className="w-[46rem] max-w-full overflow-y-auto"
          data-testid="material-sheet"
        >
          <div className="mb-3 flex items-start justify-between gap-2">
            <div>
              <DialogTitle className="text-lg font-semibold text-heading">
                {name || <Skeleton className="h-6 w-48" />}
              </DialogTitle>
              <DialogDescription className="mt-1 text-sm text-muted">
                {m && (
                  <>
                    {t(`materials.category.${m.category}`)}
                    {other ? <span lang={lang === 'ar' ? 'en' : 'ar'}> · {other}</span> : null}
                  </>
                )}
              </DialogDescription>
            </div>
            <DialogClose asChild>
              <Button variant="ghost" size="icon" aria-label={t('ui.close')}>
                <X className="size-4" aria-hidden />
              </Button>
            </DialogClose>
          </div>

          {detail.isLoading && <Skeleton className="h-32 w-full" />}
          {detail.isError && (
            <p role="alert" className="text-sm text-fail-text">
              {t('errors.loadFailed')}
            </p>
          )}

          {m && s && (
            <>
              <div className="mb-4 flex flex-wrap items-center gap-2">
                {s.hasTest && s.source && <SourceChip source={s.source as Source} />}
                {s.freshness && <FreshnessChip freshness={s.freshness} />}
                <ReadyChip kind="evaluate" ok={s.canEvaluate} />
                <ReadyChip kind="design" ok={s.canDesign} />
                {cur && (
                  <span className="text-xs text-muted">
                    {t('rules.version', { n: cur.version })}
                  </span>
                )}
              </div>

              <div className="mb-5 flex flex-col gap-3">
                <BlockerList blockers={s.evaluateBlockers ?? []} kind="evaluate" />
                <BlockerList
                  blockers={(s.designBlockers ?? []).filter((b) => b.workflow === 'design')}
                  kind="design"
                />
                {(s.declaredKeyFields ?? []).length > 0 && (
                  <p className="text-xs text-warn-text" data-testid="declared-note">
                    {t('materials.declaredKey', {
                      fields: (s.declaredKeyFields ?? [])
                        .map((k) => t(`materials.field.${k}`, { defaultValue: k }))
                        .join(', '),
                    })}
                  </p>
                )}
                {(s.drift ?? [])
                  .filter((d) => d.status !== 'within' && d.delta !== 0)
                  .map((d) => (
                    <p
                      key={d.field}
                      className={`text-xs ${d.status === 'beyond' ? 'text-warn-text' : 'text-muted'}`}
                      data-testid="drift-note"
                    >
                      {t(
                        d.status === 'beyond' ? 'materials.drift.beyond' : 'materials.drift.noTol',
                        {
                          field:
                            d.field === 'fm' ? t('materials.fm') : t(`materials.field.${d.field}`),
                          from: f.number(d.previous),
                          to: f.number(d.current),
                        },
                      )}
                    </p>
                  ))}
              </div>

              {(canEnter || caps.includes('materials.write')) && (
                <div className="mb-5 flex flex-wrap gap-2">
                  {canEnter && (
                    <Button onClick={() => setEntry('test')} data-testid="new-test">
                      <FilePlus2 className="size-4" aria-hidden />
                      {t('materials.sheet.newTest')}
                    </Button>
                  )}
                  {canEnter && hasDeclared && (
                    <Button
                      variant="secondary"
                      onClick={() => setEntry('upgrade')}
                      data-testid="upgrade-source"
                    >
                      <ShieldCheck className="size-4" aria-hidden />
                      {t('materials.sheet.upgrade')}
                    </Button>
                  )}
                </div>
              )}

              <Tabs defaultValue="props">
                <TabsList>
                  <TabsTrigger value="props">{t('materials.sheet.properties')}</TabsTrigger>
                  {gradation.length > 0 && (
                    <TabsTrigger value="grad">{t('materials.sheet.gradation')}</TabsTrigger>
                  )}
                  <TabsTrigger value="history">{t('materials.sheet.history')}</TabsTrigger>
                </TabsList>

                <TabsContent value="props" className="pt-4">
                  {!cur && <p className="text-sm text-muted">{t('materials.sheet.noTest')}</p>}
                  {cur && (
                    <>
                      <dl className="grid grid-cols-2 gap-4" data-testid="properties">
                        <Field label={t('materials.col.plant')}>
                          {plant
                            ? lang === 'ar'
                              ? plant.nameAr
                              : plant.nameEn
                            : t('materials.entry.allPlants')}
                        </Field>
                        <Field label={t('materials.entry.testedAt')}>
                          <Ltr>{cur.testedAt}</Ltr>
                        </Field>
                        {s.fm != null && (
                          <Field label={t('materials.fm')}>
                            <Ltr>
                              {f.number(s.fm, {
                                minimumFractionDigits: 2,
                                maximumFractionDigits: 2,
                              })}
                            </Ltr>
                          </Field>
                        )}
                        {fields
                          .filter((d) => cur.properties[d.key] !== undefined)
                          .map((d) => (
                            <Field key={d.key} label={t(`materials.field.${d.key}`)}>
                              <span className="flex flex-wrap items-center gap-2">
                                {fmt(cur.properties[d.key], d)}
                                <SourceChip source={cur.fieldSources[d.key] ?? cur.source} />
                              </span>
                            </Field>
                          ))}
                        {cur.declaredReason && (
                          <Field wide label={t('materials.entry.reason')}>
                            {cur.declaredReason}
                          </Field>
                        )}
                      </dl>
                      <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
                        {(['sg_ssd', 'absorption_pct', 'fm'] as const).map((k) => {
                          const vals = trend(k);
                          if (vals.length < 2) return null;
                          return (
                            <div key={k} className="rounded-md border border-line p-3">
                              <p className="mb-1 text-xs text-muted">
                                {k === 'fm' ? t('materials.fm') : t(`materials.field.${k}`)}
                              </p>
                              <Sparkline
                                values={vals}
                                label={k === 'fm' ? t('materials.fm') : t(`materials.field.${k}`)}
                                format={(n) => f.number(n)}
                              />
                            </div>
                          );
                        })}
                      </div>
                    </>
                  )}
                </TabsContent>

                {gradation.length > 0 && (
                  <TabsContent value="grad" className="pt-4">
                    <Suspense fallback={<Skeleton className="h-64 w-full" />}>
                      <GradationChart points={gradation} name={name} />
                    </Suspense>
                    <table className="mt-4 w-full text-sm" data-testid="gradation-values">
                      <caption className="sr-only">{t('materials.sheet.gradation')}</caption>
                      <thead>
                        <tr className="text-muted">
                          <th scope="col" className="py-1 text-start font-medium">
                            {t('materials.chart.sieve')}
                          </th>
                          <th scope="col" className="py-1 text-start font-medium">
                            {t('materials.chart.passing')}
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {[...gradation]
                          .sort((a, b) => b.sieve_mm - a.sieve_mm)
                          .map((p) => (
                            <tr key={p.sieve_mm} className="border-t border-line">
                              <td className="py-1">
                                <Ltr>{f.number(p.sieve_mm)}</Ltr>
                              </td>
                              <td className="py-1">
                                <Ltr>{f.number(p.passing_pct)}</Ltr>
                              </td>
                            </tr>
                          ))}
                      </tbody>
                    </table>
                  </TabsContent>
                )}

                <TabsContent value="history" className="pt-4">
                  {history.isLoading && <Skeleton className="h-16 w-full" />}
                  <ol className="flex flex-col gap-3" data-testid="test-history">
                    {(history.data ?? []).map((v) => (
                      <li
                        key={v.id}
                        className="rounded-md border border-line p-3 text-sm"
                        data-version={v.version}
                      >
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <strong>
                            {t('rules.version', { n: v.version })}
                            {v.isCurrent ? ` · ${t('materials.sheet.current')}` : ''}
                          </strong>
                          <SourceChip source={v.source} />
                        </div>
                        <p className="mt-1 text-xs text-muted">
                          <Ltr>{v.testedAt}</Ltr>
                          {v.labRef ? (
                            <>
                              {' '}
                              · <Ltr>{v.labRef}</Ltr>
                            </>
                          ) : null}{' '}
                          · {f.dateTime(v.createdAt)}
                        </p>
                        {v.declaredReason && <p className="mt-1 text-xs">{v.declaredReason}</p>}
                        {v.attachment && (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="mt-1"
                            onClick={() => open(v)}
                          >
                            <FileText className="size-4" aria-hidden />
                            <Ltr>{v.attachment.filename}</Ltr>
                          </Button>
                        )}
                      </li>
                    ))}
                  </ol>
                </TabsContent>
              </Tabs>
            </>
          )}
        </SheetContent>
      </Dialog>
      {entry && m && (
        <EntryDialog
          target={{ kind: 'test', material: m, current: cur, upgrade: entry === 'upgrade' }}
          onClose={() => setEntry(null)}
        />
      )}
    </>
  );
}
