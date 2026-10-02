import {
  Button,
  Dialog,
  DialogClose,
  DialogDescription,
  DialogTitle,
  Ltr,
  SheetContent,
  Skeleton,
} from '@khalta/ui';
import { useQuery } from '@tanstack/react-query';
import { ShieldCheck, X } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMe } from '../lib/auth';
import { useFormat } from '../lib/format';
import { usePlant } from '../lib/plant';
import { usePrefs } from '../lib/prefs';
import { designQuery } from './api';
import { AttestDialog } from './AttestDialog';
import { ApprovalChip, DesignStatusChip } from './chips';

export function DesignSheet({ id, onClose }: { id: string | null; onClose: () => void }) {
  const { t } = useTranslation();
  const { lang } = usePrefs();
  const f = useFormat();
  const { data: me } = useMe();
  const { plants } = usePlant();
  const q = useQuery({ ...designQuery(id ?? ''), enabled: !!id });
  const [attest, setAttest] = useState(false);
  if (!id) return null;
  const d = q.data?.design;
  const canAttest =
    !!d &&
    (me?.capabilities ?? []).includes('design.attest') &&
    d.status === 'draft' &&
    d.approvalSource === null &&
    !!d.importBatchId;
  const plant = plants.find((p) => p.id === d?.plantId);
  const r = d?.requirements;
  const num = (n: string) => f.number(Number(n), { maximumFractionDigits: 3 });

  return (
    <>
      <Dialog open onOpenChange={(o) => !o && onClose()}>
        <SheetContent
          side="end"
          className="w-[44rem] max-w-full overflow-y-auto"
          data-testid="design-sheet"
        >
          <div className="mb-3 flex items-start justify-between gap-2">
            <div>
              <DialogTitle className="text-base font-semibold text-heading">
                {d ? <Ltr mono>{d.code}</Ltr> : <Skeleton className="h-6 w-40" />}
              </DialogTitle>
              <DialogDescription className="mt-1 text-sm text-muted">{d?.name}</DialogDescription>
            </div>
            <DialogClose asChild>
              <Button variant="ghost" size="icon" aria-label={t('ui.close')}>
                <X className="size-4" aria-hidden />
              </Button>
            </DialogClose>
          </div>
          {q.isLoading && <Skeleton className="h-32 w-full" />}
          {d && q.data && (
            <>
              <div className="mb-4 flex flex-wrap items-center gap-2">
                <DesignStatusChip status={d.status} />
                <ApprovalChip design={d} />
                {d.synthetic && (
                  <span className="rounded-md border border-warn px-2 py-0.5 text-xs text-warn-text">
                    {t('library.synthetic')}
                  </span>
                )}
              </div>
              {d.evaluationPending && (
                <p className="mb-4 text-sm text-muted" data-testid="evaluation-pending">
                  {t('library.evaluationPending')}
                </p>
              )}
              {canAttest && (
                <Button className="mb-4" onClick={() => setAttest(true)} data-testid="attest-open">
                  <ShieldCheck className="size-4" aria-hidden />
                  {t('library.attest.open')}
                </Button>
              )}
              <dl className="grid grid-cols-2 gap-4 text-sm">
                <Field label={t('library.col.plant')}>
                  {plant ? (lang === 'ar' ? plant.nameAr : plant.nameEn) : '–'}
                </Field>
                <Field label={t('library.field.source')}>
                  {q.data.source ? <Ltr>{q.data.source}</Ltr> : '–'}
                </Field>
                <Field label={t('library.field.strength')}>
                  {r?.fcMpa != null ? (
                    <>
                      <Ltr>{t('library.unit.mpa', { n: f.number(r.fcMpa) })}</Ltr>
                      {r.basis ? ` · ${t(`library.basis.${r.basis}`)}` : ''}
                      {r.testAgeDays != null
                        ? ` · ${t('library.field.ageDays', { n: f.number(r.testAgeDays) })}`
                        : ''}
                    </>
                  ) : (
                    '–'
                  )}
                </Field>
                <Field label={t('library.field.exposure')}>
                  {(r?.exposure ?? []).length ? <Ltr>{(r!.exposure ?? []).join(' ')}</Ltr> : '–'}
                </Field>
                <Field label={t('library.field.slump')}>
                  {r?.slumpMm != null ? (
                    <Ltr>{t('library.unit.mm', { n: f.number(r.slumpMm) })}</Ltr>
                  ) : (
                    '–'
                  )}
                </Field>
                <Field label={t('library.field.nmas')}>
                  {r?.nmasMm != null ? (
                    <Ltr>{t('library.unit.mm', { n: f.number(r.nmasMm) })}</Ltr>
                  ) : (
                    '–'
                  )}
                </Field>
                <Field label={t('library.field.pumpable')}>
                  {r?.pumpable == null ? '–' : t(r.pumpable ? 'library.yes' : 'library.no')}
                </Field>
                <Field label={t('library.col.volume')}>
                  {d.avgMonthlyVolumeM3 ? (
                    <Ltr>
                      {t('library.unit.m3month', { n: f.number(Number(d.avgMonthlyVolumeM3)) })}
                    </Ltr>
                  ) : (
                    '–'
                  )}
                </Field>
                <Field label={t('library.field.importedRef')} wide>
                  {d.importedApprovalRef ?? '–'}
                </Field>
                {d.externalApprovalRef && (
                  <Field label={t('library.field.attestedRef')} wide>
                    {d.externalApprovalRef}
                  </Field>
                )}
              </dl>

              {d.warnings.length > 0 && (
                <section className="mt-6" aria-label={t('library.warnings')}>
                  <h3 className="mb-2 text-sm font-semibold text-heading">
                    {t('library.warnings')}
                  </h3>
                  <ul
                    className="flex flex-col gap-1 text-sm text-warn-text"
                    data-testid="design-warnings"
                  >
                    {d.warnings.map((w, i) => (
                      <li key={i}>
                        {t(`library.warn.${w.code}`, { defaultValue: w.code })}
                        {w.detail ? ` · ${w.detail}` : ''}
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              <section className="mt-6" aria-label={t('library.lines')}>
                <h3 className="mb-2 text-sm font-semibold text-heading">{t('library.lines')}</h3>
                <table className="w-full text-sm" data-testid="design-lines">
                  <caption className="sr-only">{t('library.lines')}</caption>
                  <thead>
                    <tr className="text-muted">
                      <th scope="col" className="py-1 text-start font-medium">
                        {t('library.line.material')}
                      </th>
                      <th scope="col" className="py-1 text-start font-medium">
                        {t('library.line.original')}
                      </th>
                      <th scope="col" className="py-1 text-start font-medium">
                        {t('library.line.kg')}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {q.data.lines.map((l) => (
                      <tr key={l.id} className="border-t border-line">
                        <td className="py-1.5">
                          {lang === 'ar' ? (l.nameAr ?? l.nameEn) : l.nameEn}
                          <span className="block text-xs text-muted">
                            {t(`library.match.${l.matchMethod}`)} ·{' '}
                            {t(`materials.category.${l.category}`)}
                          </span>
                        </td>
                        <td className="py-1.5">
                          <Ltr>
                            {num(l.originalQuantity)}{' '}
                            {l.originalUnit === 'kg/m3' ? 'kg/m³' : 'L/m³'}
                          </Ltr>
                        </td>
                        <td className="py-1.5">
                          <Ltr>{t('library.unit.kgm3', { n: num(l.quantityKgM3) })}</Ltr>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </section>

              <section className="mt-6" aria-label={t('library.history')}>
                <h3 className="mb-2 text-sm font-semibold text-heading">{t('library.history')}</h3>
                <ol className="flex flex-col gap-2" data-testid="design-history">
                  {q.data.transitions.map((x) => (
                    <li key={x.id} className="rounded-md border border-line p-3 text-sm">
                      <strong>
                        {x.fromStatus === 'none'
                          ? t('library.created')
                          : `${t(`library.status.${x.fromStatus}`)} → ${t(`library.status.${x.toStatus}`)}`}
                      </strong>
                      <span className="block text-xs text-muted">
                        {x.actor ?? '–'} · {f.dateTime(x.at)}
                      </span>
                      {typeof x.evidence['note'] === 'string' && (
                        <span className="mt-1 block text-xs">{String(x.evidence['note'])}</span>
                      )}
                    </li>
                  ))}
                </ol>
              </section>
            </>
          )}
        </SheetContent>
      </Dialog>
      {attest && d && (
        <AttestDialog
          design={d}
          isImporter={d.createdBy === me?.user.id}
          onClose={() => setAttest(false)}
        />
      )}
    </>
  );
}

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
      <dd>{children}</dd>
    </div>
  );
}
