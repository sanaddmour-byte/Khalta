import {
  Button,
  EmptyState,
  Input,
  Ltr,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  Table,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Td,
  Th,
  toast,
} from '@khalta/ui';
import { useQuery } from '@tanstack/react-query';
import { Download, Library, Upload } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from '@tanstack/react-router';
import { useMe } from '../lib/auth';
import { useFormat } from '../lib/format';
import { usePlant } from '../lib/plant';
import { usePrefs } from '../lib/prefs';
import { designsQuery } from './api';
import { ApprovalChip, DesignStatusChip, RevalidationChip, VerdictChip } from './chips';
import { DesignSheet } from './DesignSheet';
import { DataQualityTab, PortfolioTab } from './PortfolioTab';
import { exportDesigns } from '../exports/api';
import { StrengthModelsTab } from '../strength/StrengthModelsTab';
import { SectionPage } from '../pages/Section';

const ALL = 'all';
const STATUSES = ['draft', 'evaluated', 'approved', 'in_production'] as const;

export function LibraryPage() {
  const { t } = useTranslation();
  const { lang } = usePrefs();
  const f = useFormat();
  const { data: me } = useMe();
  const { plants, selected } = usePlant();
  const caps = me?.capabilities ?? [];
  const canRead = caps.includes('library.read');
  const [tab, setTab] = useState<
    'all' | 'portfolio' | 'quality' | 'queue' | 'revalidation' | 'trial' | 'awaiting' | 'strength'
  >('all');
  const [status, setStatus] = useState(ALL);
  const [q, setQ] = useState('');
  // the submittal's QR code links here: /library?design=<id> opens that design
  const [open, setOpen] = useState<string | null>(() =>
    new URLSearchParams(window.location.search).get('design'),
  );
  const { data, isLoading, isError } = useQuery({
    ...designsQuery({
      ...(tab === 'queue' ? { queue: 'true' } : {}),
      ...(tab === 'revalidation' ? { revalidation: 'true' } : {}),
      ...(tab === 'trial' ? { stage: 'trial' } : {}),
      ...(tab === 'awaiting' ? { stage: 'awaiting' } : {}),
      ...(status !== ALL && tab === 'all' ? { status } : {}),
      ...(selected && selected !== ALL ? { plantId: selected } : {}),
      q: q.trim() || undefined,
    }),
    enabled: canRead && tab !== 'portfolio' && tab !== 'quality' && tab !== 'strength',
  });
  if (me && !canRead) return <SectionPage id="library" />;
  const plantName = (id: string) => {
    const p = plants.find((x) => x.id === id);
    return p ? (lang === 'ar' ? p.nameAr : p.nameEn) : '–';
  };

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-heading">{t('nav.library')}</h1>
          <p className="mt-1 max-w-3xl text-sm text-muted">{t('library.intro')}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {caps.includes('export.csv') && (
            <Button
              variant="secondary"
              onClick={() =>
                exportDesigns(selected && selected !== ALL ? selected : undefined)
                  .then((name) => toast.success(t('exports.done', { name })))
                  .catch(() => toast.error(t('exports.failed')))
              }
              data-testid="export-designs-csv"
            >
              <Download className="size-4" aria-hidden />
              {t('exports.designs')}
            </Button>
          )}
          {caps.includes('import.run') && (
            <Button asChild variant="secondary">
              <Link to="/imports">
                <Upload className="size-4" aria-hidden />
                {t('library.import')}
              </Link>
            </Button>
          )}
        </div>
      </header>
      {caps.includes('export.csv') && (
        <p className="-mt-3 max-w-3xl text-xs text-muted" data-testid="export-note">
          {t('exports.note')}
        </p>
      )}

      <Tabs
        value={tab}
        className="flex flex-col gap-6"
        onValueChange={(v) => setTab(v as typeof tab)}
      >
        <TabsList className="max-w-full justify-start overflow-x-auto">
          <TabsTrigger value="all">{t('library.tabs.all')}</TabsTrigger>
          <TabsTrigger value="portfolio" data-testid="portfolio-tab">
            {t('portfolio.title')}
          </TabsTrigger>
          <TabsTrigger value="quality" data-testid="quality-tab">
            {t('dataQuality.title')}
          </TabsTrigger>
          <TabsTrigger value="strength" data-testid="strength-tab-trigger">
            {t('library.tabs.strength')}
          </TabsTrigger>
          <TabsTrigger value="revalidation" data-testid="revalidation-tab">
            {t('library.tabs.revalidation')}
          </TabsTrigger>
          <TabsTrigger value="trial" data-testid="trial-tab">
            {t('library.tabs.trial')}
          </TabsTrigger>
          <TabsTrigger value="awaiting" data-testid="awaiting-tab">
            {t('library.tabs.awaiting')}
          </TabsTrigger>
          {caps.includes('design.attest') && (
            <TabsTrigger value="queue" data-testid="queue-tab">
              {t('library.tabs.queue')}
            </TabsTrigger>
          )}
        </TabsList>
        <TabsContent value={tab} className="flex flex-col gap-6">
          {tab === 'portfolio' ? (
            <PortfolioTab onOpen={setOpen} />
          ) : tab === 'quality' ? (
            <DataQualityTab onOpen={setOpen} />
          ) : tab === 'strength' ? (
            <StrengthModelsTab />
          ) : (
            <>
              <div
                className="flex flex-wrap items-end gap-3"
                role="search"
                aria-label={t('rules.filters')}
              >
                <div className="w-60 max-w-full">
                  <Input
                    value={q}
                    onChange={(e) => setQ(e.target.value)}
                    placeholder={t('library.search')}
                    aria-label={t('library.search')}
                    data-testid="library-search"
                  />
                </div>
                {tab === 'all' && (
                  <Select value={status} onValueChange={setStatus}>
                    <SelectTrigger aria-label={t('library.col.status')} className="w-48">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={ALL}>{t('library.allStatuses')}</SelectItem>
                      {STATUSES.map((s) => (
                        <SelectItem key={s} value={s}>
                          {t(`library.status.${s}`)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </div>
              {tab === 'queue' && (
                <p className="max-w-3xl text-sm text-muted">{t('library.queueHint')}</p>
              )}
              {tab === 'trial' && (
                <p className="max-w-3xl text-sm text-muted">{t('library.trialHint')}</p>
              )}
              {tab === 'awaiting' && (
                <p className="max-w-3xl text-sm text-muted">{t('library.awaitingHint')}</p>
              )}
              {tab === 'revalidation' && (
                <p className="max-w-3xl text-sm text-muted">{t('library.revalidationHint')}</p>
              )}

              {isLoading && <Skeleton className="h-32 w-full" />}
              {isError && (
                <p role="alert" className="text-sm text-fail-text">
                  {t('errors.loadFailed')}
                </p>
              )}
              {data && data.length === 0 && (
                <EmptyState
                  icon={<Library className="size-8" aria-hidden />}
                  title={t(
                    tab === 'queue'
                      ? 'library.emptyQueue.title'
                      : tab === 'revalidation'
                        ? 'library.emptyRevalidation.title'
                        : tab === 'trial'
                          ? 'library.emptyTrial.title'
                          : tab === 'awaiting'
                            ? 'library.emptyAwaiting.title'
                            : 'library.empty.title',
                  )}
                  description={t(
                    tab === 'queue'
                      ? 'library.emptyQueue.description'
                      : tab === 'revalidation'
                        ? 'library.emptyRevalidation.description'
                        : tab === 'trial'
                          ? 'library.emptyTrial.description'
                          : tab === 'awaiting'
                            ? 'library.emptyAwaiting.description'
                            : 'library.empty.description',
                  )}
                />
              )}
              {data && data.length > 0 && (
                <div className="overflow-x-auto">
                  <Table data-testid="designs-table">
                    <caption className="sr-only">{t('nav.library')}</caption>
                    <thead>
                      <tr>
                        <Th>{t('library.col.code')}</Th>
                        <Th className="hidden md:table-cell">{t('library.col.name')}</Th>
                        <Th className="hidden lg:table-cell">{t('library.col.plant')}</Th>
                        <Th>{t('library.col.status')}</Th>
                        <Th className="hidden xl:table-cell">{t('library.col.volume')}</Th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.map((d) => (
                        <tr
                          key={d.id}
                          className="border-t border-line hover:bg-primary-tint"
                          data-testid="design-row"
                          data-code={d.code}
                        >
                          <Td>
                            <button
                              type="button"
                              className="text-start font-medium text-heading underline-offset-2 hover:underline"
                              onClick={() => setOpen(d.id)}
                            >
                              <Ltr mono>{d.code}</Ltr>
                            </button>
                          </Td>
                          <Td className="hidden md:table-cell">{d.name}</Td>
                          <Td className="hidden lg:table-cell">{plantName(d.plantId)}</Td>
                          <Td>
                            <span className="flex flex-wrap gap-1">
                              <DesignStatusChip status={d.status} />
                              <ApprovalChip design={d} />
                              <VerdictChip verdict={d.lastVerdict} />
                              <RevalidationChip design={d} />
                            </span>
                          </Td>
                          <Td className="hidden whitespace-nowrap xl:table-cell">
                            {d.avgMonthlyVolumeM3 ? (
                              <Ltr>
                                {t('library.unit.m3', {
                                  n: f.number(Number(d.avgMonthlyVolumeM3)),
                                })}
                              </Ltr>
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
            </>
          )}
        </TabsContent>
      </Tabs>
      <DesignSheet id={open} onClose={() => setOpen(null)} onOpen={setOpen} />
    </div>
  );
}
