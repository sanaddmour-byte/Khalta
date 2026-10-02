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
  TabsList,
  TabsTrigger,
  Td,
  Th,
} from '@khalta/ui';
import { useQuery } from '@tanstack/react-query';
import { Library, Upload } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from '@tanstack/react-router';
import { useMe } from '../lib/auth';
import { useFormat } from '../lib/format';
import { usePlant } from '../lib/plant';
import { usePrefs } from '../lib/prefs';
import { designsQuery } from './api';
import { ApprovalChip, DesignStatusChip } from './chips';
import { DesignSheet } from './DesignSheet';
import { SectionPage } from '../pages/Section';

const ALL = 'all';
const STATUSES = ['draft', 'approved', 'in_production'] as const;

export function LibraryPage() {
  const { t } = useTranslation();
  const { lang } = usePrefs();
  const f = useFormat();
  const { data: me } = useMe();
  const { plants, selected } = usePlant();
  const caps = me?.capabilities ?? [];
  const canRead = caps.includes('library.read');
  const [tab, setTab] = useState<'all' | 'queue'>('all');
  const [status, setStatus] = useState(ALL);
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const { data, isLoading, isError } = useQuery({
    ...designsQuery({
      ...(tab === 'queue' ? { queue: 'true' } : {}),
      ...(status !== ALL && tab === 'all' ? { status } : {}),
      ...(selected && selected !== ALL ? { plantId: selected } : {}),
      q: q.trim() || undefined,
    }),
    enabled: canRead,
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
        {caps.includes('import.run') && (
          <Button asChild variant="secondary">
            <Link to="/imports">
              <Upload className="size-4" aria-hidden />
              {t('library.import')}
            </Link>
          </Button>
        )}
      </header>

      <Tabs value={tab} onValueChange={(v) => setTab(v as 'all' | 'queue')}>
        <TabsList>
          <TabsTrigger value="all">{t('library.tabs.all')}</TabsTrigger>
          {caps.includes('design.attest') && (
            <TabsTrigger value="queue" data-testid="queue-tab">
              {t('library.tabs.queue')}
            </TabsTrigger>
          )}
        </TabsList>
      </Tabs>
      <div className="flex flex-wrap items-end gap-3" role="search" aria-label={t('rules.filters')}>
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
      {tab === 'queue' && <p className="max-w-3xl text-sm text-muted">{t('library.queueHint')}</p>}

      {isLoading && <Skeleton className="h-32 w-full" />}
      {isError && (
        <p role="alert" className="text-sm text-fail-text">
          {t('errors.loadFailed')}
        </p>
      )}
      {data && data.length === 0 && (
        <EmptyState
          icon={<Library className="size-8" aria-hidden />}
          title={t(tab === 'queue' ? 'library.emptyQueue.title' : 'library.empty.title')}
          description={t(
            tab === 'queue' ? 'library.emptyQueue.description' : 'library.empty.description',
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
                    </span>
                  </Td>
                  <Td className="hidden whitespace-nowrap xl:table-cell">
                    {d.avgMonthlyVolumeM3 ? (
                      <Ltr>
                        {t('library.unit.m3', { n: f.number(Number(d.avgMonthlyVolumeM3)) })}
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
      <DesignSheet id={open} onClose={() => setOpen(null)} />
    </div>
  );
}
