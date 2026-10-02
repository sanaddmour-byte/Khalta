import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  EmptyState,
  Label,
  Ltr,
  SavingStateLabel,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  Table,
  Td,
  Th,
  toast,
} from '@khalta/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../lib/api';
import { useMe } from '../lib/auth';
import { useFormat } from '../lib/format';
import { usePlant } from '../lib/plant';
import { usePrefs } from '../lib/prefs';
import {
  baselinesQuery,
  createBaseline,
  portfolioQuery,
  savingsQuery,
} from '../library/portfolioApi';
import { snapshotsQuery } from '../prices/api';
import { SectionPage } from '../pages/Section';

export function SavingsPage() {
  const { t } = useTranslation();
  const { lang } = usePrefs();
  const f = useFormat();
  const { data: me } = useMe();
  const { plants } = usePlant();
  const caps = me?.capabilities ?? [];
  const canSee = caps.includes('cost.view');
  const baselines = useQuery({ ...baselinesQuery, enabled: canSee });
  const entries = useQuery({ ...savingsQuery, enabled: canSee });
  const [create, setCreate] = useState(false);
  if (me && !canSee) return <SectionPage id="savings" />;
  const plantName = (id: string) => {
    const p = plants.find((x) => x.id === id);
    return p ? (lang === 'ar' ? p.nameAr : p.nameEn) : '–';
  };
  const jod = (v: string | null) =>
    v === null
      ? '–'
      : t('evaluation.unit.jodm3', { n: f.number(Number(v), { maximumFractionDigits: 3 }) });
  const money = (v: string | null) =>
    v === null ? '–' : f.number(Number(v), { maximumFractionDigits: 0 });
  const code = (id: string, name?: string) => name ?? id.slice(0, 8);

  return (
    <div className="flex flex-col gap-8" data-testid="savings-page">
      <header>
        <h1 className="text-2xl font-semibold text-heading">{t('nav.savings')}</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted">{t('savings.intro')}</p>
      </header>

      <section aria-label={t('savings.baselines')} className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-lg font-semibold text-heading">{t('savings.baselines')}</h2>
          {caps.includes('baseline.create') && (
            <Button onClick={() => setCreate(true)} data-testid="baseline-open">
              <Plus className="size-4" aria-hidden />
              {t('savings.createBaseline')}
            </Button>
          )}
        </div>
        <p className="max-w-3xl text-sm text-muted">{t('savings.baselineHint')}</p>
        {baselines.isLoading && <Skeleton className="h-24 w-full" />}
        {baselines.data?.length === 0 && (
          <EmptyState
            title={t('savings.noBaselines.title')}
            description={t('savings.noBaselines.description')}
          />
        )}
        {baselines.data && baselines.data.length > 0 && (
          <div className="overflow-x-auto">
            <Table data-testid="baselines-table">
              <caption className="sr-only">{t('savings.baselines')}</caption>
              <thead>
                <tr>
                  <Th>{t('library.col.code')}</Th>
                  <Th className="hidden md:table-cell">{t('library.col.plant')}</Th>
                  <Th>{t('savings.col.snapshot')}</Th>
                  <Th>{t('savings.col.cost')}</Th>
                  <Th className="hidden lg:table-cell">{t('savings.col.volume')}</Th>
                  <Th className="hidden lg:table-cell">{t('savings.col.annual')}</Th>
                </tr>
              </thead>
              <tbody>
                {baselines.data.map((b) => (
                  <tr
                    key={b.id}
                    className="border-t border-line"
                    data-testid="baseline-row"
                    data-code={b.code}
                  >
                    <Td>
                      <Ltr mono>
                        {b.code} {t('versions.short', { n: b.version })}
                      </Ltr>
                    </Td>
                    <Td className="hidden md:table-cell">{plantName(b.plantId)}</Td>
                    <Td>
                      {b.snapshotName}
                      <span className="block text-xs text-muted">
                        <Ltr>{b.asOf}</Ltr>
                      </span>
                    </Td>
                    <Td className="whitespace-nowrap">
                      <Ltr>{jod(b.costJodPerM3)}</Ltr>
                    </Td>
                    <Td className="hidden whitespace-nowrap lg:table-cell">
                      {b.monthlyVolumeM3 ? (
                        <>
                          <Ltr>
                            {t('library.unit.m3month', { n: f.number(Number(b.monthlyVolumeM3)) })}
                          </Ltr>
                          <span className="block text-xs text-muted">
                            {t('savings.volumeEstimate')}
                          </span>
                        </>
                      ) : (
                        '–'
                      )}
                    </Td>
                    <Td className="hidden whitespace-nowrap lg:table-cell">
                      {b.annualJod ? (
                        <>
                          <Ltr>{t('savings.jodYear', { n: money(b.annualJod) })}</Ltr>
                          <span className="block text-xs text-muted">{t('savings.estimate')}</span>
                        </>
                      ) : (
                        '–'
                      )}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </div>
        )}
      </section>

      <section aria-label={t('savings.opportunities')} className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold text-heading">{t('savings.opportunities')}</h2>
        <p className="max-w-3xl text-sm text-muted">{t('savings.opportunityHint')}</p>
        {entries.isLoading && <Skeleton className="h-24 w-full" />}
        {entries.data?.length === 0 && (
          <EmptyState
            title={t('savings.noEntries.title')}
            description={t('savings.noEntries.description')}
          />
        )}
        {entries.data && entries.data.length > 0 && (
          <div className="overflow-x-auto">
            <Table data-testid="entries-table">
              <caption className="sr-only">{t('savings.opportunities')}</caption>
              <thead>
                <tr>
                  <Th>{t('library.col.code')}</Th>
                  <Th>{t('savings.col.state')}</Th>
                  <Th>{t('savings.col.saving')}</Th>
                  <Th className="hidden lg:table-cell">{t('savings.col.annual')}</Th>
                  <Th className="hidden md:table-cell">{t('savings.col.snapshot')}</Th>
                </tr>
              </thead>
              <tbody>
                {entries.data.map((e) => (
                  <tr
                    key={e.id}
                    className="border-t border-line"
                    data-testid="entry-row"
                    data-state={e.state}
                  >
                    <Td>
                      <Ltr mono>{code(e.variantDesignId, `${e.code} v${e.variantVersion}`)}</Ltr>
                    </Td>
                    <Td>
                      <SavingStateLabel state={e.state} />
                      {e.provisional && (
                        <span className="block text-xs text-muted">
                          {t('evaluation.provisional')}
                        </span>
                      )}
                    </Td>
                    <Td className="whitespace-nowrap">
                      <Ltr>{jod(e.savingJodPerM3)}</Ltr>
                    </Td>
                    <Td className="hidden whitespace-nowrap lg:table-cell">
                      {e.annualJod ? (
                        <>
                          <Ltr>{t('savings.jodYear', { n: money(e.annualJod) })}</Ltr>
                          <span className="block text-xs text-muted">{t('savings.estimate')}</span>
                        </>
                      ) : (
                        '–'
                      )}
                    </Td>
                    <Td className="hidden md:table-cell">{e.snapshotName}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </div>
        )}
      </section>
      {create && <BaselineDialog onClose={() => setCreate(false)} />}
    </div>
  );
}

function BaselineDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const portfolio = useQuery(portfolioQuery('all'));
  const snaps = useQuery(snapshotsQuery);
  const [design, setDesign] = useState('');
  const [snap, setSnap] = useState('');
  const eligible = (portfolio.data?.rows ?? []).filter(
    (r) => r.approvalSource !== null && ['approved', 'in_production'].includes(r.status),
  );
  const m = useMutation({
    mutationFn: () => createBaseline({ designId: design, priceSnapshotId: snap }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['savings'] });
      await qc.invalidateQueries({ queryKey: ['designs'] });
      toast.success(t('savings.baselineDone'));
      onClose();
    },
  });
  const err = m.error instanceof ApiError ? m.error : null;
  const reasons = (err?.details as { reasons?: { code: string }[] } | undefined)?.reasons ?? [];
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent closeLabel={t('ui.close')} className="max-w-xl" data-testid="baseline-dialog">
        <DialogTitle className="mb-1 text-lg font-semibold text-heading">
          {t('savings.createBaseline')}
        </DialogTitle>
        <DialogDescription className="mb-4 text-sm text-muted">
          {t('savings.baselineDialogHint')}
        </DialogDescription>
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1">
            <Label htmlFor="bl-design">{t('savings.pickDesign')}</Label>
            <Select value={design} onValueChange={setDesign}>
              <SelectTrigger id="bl-design" data-testid="baseline-design">
                <SelectValue placeholder={t('editor.choose')} />
              </SelectTrigger>
              <SelectContent>
                {eligible.map((r) => (
                  <SelectItem key={r.id} value={r.id}>
                    {r.code} {t('versions.short', { n: r.version })}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="bl-snap">{t('savings.pickSnapshot')}</Label>
            <Select value={snap} onValueChange={setSnap}>
              <SelectTrigger id="bl-snap" data-testid="baseline-snapshot">
                <SelectValue placeholder={t('editor.choose')} />
              </SelectTrigger>
              <SelectContent>
                {(snaps.data ?? []).map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.name} · {s.asOf}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {snaps.data?.length === 0 && (
              <p className="text-xs text-warn-text">{t('savings.noSnapshots')}</p>
            )}
          </div>
        </div>
        {err && (
          <div role="alert" className="mt-3 text-sm text-fail-text" data-testid="baseline-error">
            <p>{err.message}</p>
            {reasons.length > 0 && (
              <ul className="list-disc ps-5 text-xs">
                {reasons.map((r) => (
                  <li key={r.code}>{t(`savings.reason.${r.code}`, { defaultValue: r.code })}</li>
                ))}
              </ul>
            )}
          </div>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            {t('ui.close')}
          </Button>
          <Button
            onClick={() => m.mutate()}
            disabled={!design || !snap || m.isPending}
            data-testid="baseline-submit"
          >
            {t('savings.createBaseline')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
