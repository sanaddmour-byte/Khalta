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
  Td,
  Th,
} from '@khalta/ui';
import { CATEGORIES } from '@khalta/engine';
import { useQuery } from '@tanstack/react-query';
import { Boxes, Plus } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMe } from '../lib/auth';
import { useFormat } from '../lib/format';
import { usePlant } from '../lib/plant';
import { usePrefs } from '../lib/prefs';
import { SectionPage } from '../pages/Section';
import { materialsQuery, type MaterialRow } from './api';
import { FreshnessChip, ReadyChip, SourceChip } from './chips';
import { EntryDialog } from './EntryDialog';
import { MaterialSheet } from './MaterialSheet';

const ALL = 'all';

export function MaterialsPage() {
  const { t } = useTranslation();
  const { lang } = usePrefs();
  const f = useFormat();
  const { data: me } = useMe();
  const { plants, selected } = usePlant();
  const caps = me?.capabilities ?? [];
  const canRead = caps.includes('materials.read');
  const [category, setCategory] = useState(ALL);
  const [q, setQ] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const { data, isLoading, isError } = useQuery({
    ...materialsQuery({
      category: category === ALL ? undefined : category,
      q: q.trim() || undefined,
      plantId: selected && selected !== 'all' ? selected : undefined,
    }),
    enabled: canRead,
  });

  if (me && !canRead) return <SectionPage id="materials" />;

  const name = (m: MaterialRow) =>
    lang === 'ar' ? (m.marketNameAr ?? m.marketNameEn) : m.marketNameEn;
  const plantName = (id: string | null) => {
    const p = plants.find((x) => x.id === id);
    return p ? (lang === 'ar' ? p.nameAr : p.nameEn) : t('materials.entry.allPlants');
  };

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-heading">{t('nav.materials')}</h1>
          <p className="mt-1 max-w-3xl text-sm text-muted">{t('materials.intro')}</p>
        </div>
        {caps.includes('materials.write') && (
          <Button onClick={() => setCreating(true)} data-testid="new-material">
            <Plus className="size-4" aria-hidden />
            {t('materials.new')}
          </Button>
        )}
      </header>

      <div className="flex flex-wrap items-end gap-3" role="search" aria-label={t('rules.filters')}>
        <div className="w-64 max-w-full">
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t('materials.search')}
            aria-label={t('materials.search')}
            data-testid="materials-search"
          />
        </div>
        <Select value={category} onValueChange={setCategory}>
          <SelectTrigger aria-label={t('materials.col.category')} className="w-52">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>{t('materials.allCategories')}</SelectItem>
            {CATEGORIES.map((c) => (
              <SelectItem key={c} value={c}>
                {t(`materials.category.${c}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {isLoading && (
        <div className="flex flex-col gap-2">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      )}
      {isError && (
        <p role="alert" className="text-sm text-fail-text">
          {t('errors.loadFailed')}
        </p>
      )}
      {data && data.length === 0 && (
        <EmptyState
          icon={<Boxes className="size-8" aria-hidden />}
          title={t('materials.empty.title')}
          description={t('materials.empty.description')}
        />
      )}
      {data && data.length > 0 && (
        <div className="overflow-x-auto">
          <Table data-testid="materials-table">
            <caption className="sr-only">{t('nav.materials')}</caption>
            <thead>
              <tr>
                <Th>{t('materials.col.name')}</Th>
                <Th className="hidden lg:table-cell">{t('materials.col.category')}</Th>
                <Th className="hidden xl:table-cell">{t('materials.col.plant')}</Th>
                <Th className="hidden md:table-cell">{t('materials.fm')}</Th>
                <Th className="hidden lg:table-cell">{t('materials.col.tested')}</Th>
                <Th>{t('materials.col.source')}</Th>
                <Th className="hidden xl:table-cell">{t('materials.col.freshness')}</Th>
                <Th>{t('materials.col.ready')}</Th>
              </tr>
            </thead>
            <tbody>
              {data.map((m) => (
                <tr
                  key={m.id}
                  className="border-t border-line hover:bg-primary-tint"
                  data-testid="material-row"
                  data-material={m.marketNameEn}
                >
                  <Td>
                    <button
                      type="button"
                      className="text-start font-medium text-heading underline-offset-2 hover:underline"
                      onClick={() => setOpenId(m.id)}
                    >
                      {name(m)}
                    </button>
                    <span className="block text-xs text-muted lg:hidden">
                      {t(`materials.category.${m.category}`)}
                    </span>
                  </Td>
                  <Td className="hidden lg:table-cell">{t(`materials.category.${m.category}`)}</Td>
                  <Td className="hidden xl:table-cell">{plantName(m.plantId)}</Td>
                  <Td className="hidden md:table-cell">
                    {m.fm != null ? (
                      <Ltr>
                        {f.number(m.fm, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                      </Ltr>
                    ) : (
                      '–'
                    )}
                  </Td>
                  <Td className="hidden whitespace-nowrap lg:table-cell">
                    {m.testedAt ? <Ltr>{m.testedAt}</Ltr> : '–'}
                  </Td>
                  <Td>
                    {m.source ? (
                      <SourceChip source={m.source} />
                    ) : (
                      <span className="text-xs text-muted">{t('materials.noTest')}</span>
                    )}
                  </Td>
                  <Td className="hidden xl:table-cell">
                    {m.freshness ? <FreshnessChip freshness={m.freshness} /> : '–'}
                  </Td>
                  <Td>
                    <span className="flex flex-wrap gap-1">
                      <ReadyChip kind="evaluate" ok={m.canEvaluate} />
                      <ReadyChip kind="design" ok={m.canDesign} />
                    </span>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </div>
      )}

      <MaterialSheet id={openId} onClose={() => setOpenId(null)} />
      {creating && (
        <EntryDialog
          target={{ kind: 'new' }}
          onClose={() => setCreating(false)}
          onSaved={(id) => setOpenId(id)}
        />
      )}
    </div>
  );
}
