import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
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
  Table,
  Td,
  Th,
  toast,
} from '@khalta/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Factory, Pencil, Plus } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../lib/api';
import { useMe } from '../lib/auth';
import { usePrefs } from '../lib/prefs';
import { SectionPage } from '../pages/Section';
import { adminPlantsQuery, savePlant, settingsQuery, type AdminPlant } from './api';

const empty = {
  code: '',
  nameEn: '',
  nameAr: '',
  city: '',
  region: '',
  ambientProfile: 'moderate' as const,
  haulCostJodPerM3Km: '',
  isActive: true,
};

function PlantDialog({ plant, onClose }: { plant: AdminPlant | null; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [v, setV] = useState(
    plant
      ? {
          code: plant.code,
          nameEn: plant.nameEn,
          nameAr: plant.nameAr,
          city: plant.city ?? '',
          region: plant.region ?? '',
          ambientProfile: plant.ambientProfile,
          haulCostJodPerM3Km: plant.haulCostJodPerM3Km ?? '',
          isActive: plant.isActive,
        }
      : empty,
  );
  const set = <K extends keyof typeof v>(k: K, val: (typeof v)[K]) =>
    setV((s) => ({ ...s, [k]: val }));
  const m = useMutation({
    mutationFn: () =>
      savePlant(plant?.id ?? null, {
        code: v.code.trim(),
        nameEn: v.nameEn.trim(),
        nameAr: v.nameAr.trim(),
        city: v.city.trim() || null,
        region: v.region.trim() || null,
        ambientProfile: v.ambientProfile,
        haulCostJodPerM3Km: v.haulCostJodPerM3Km.trim() || null,
        ...(plant && { isActive: v.isActive }),
      }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['plants'] });
      toast.success(t('plants.saved'));
      onClose();
    },
  });
  const err = m.error instanceof ApiError ? m.error.message : null;
  const ok = v.code.trim() && v.nameEn.trim() && v.nameAr.trim();
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent closeLabel={t('ui.close')} className="max-w-xl" data-testid="plant-dialog">
        <DialogTitle className="mb-1 text-lg font-semibold text-heading">
          {plant ? t('plants.edit') : t('plants.new')}
        </DialogTitle>
        <DialogDescription className="mb-4 text-sm text-muted">
          {t('plants.formHint')}
        </DialogDescription>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="flex flex-col gap-1">
            <Label htmlFor="p-code">{t('plants.col.code')}</Label>
            <Input
              id="p-code"
              dir="ltr"
              value={v.code}
              onChange={(e) => set('code', e.target.value)}
              data-testid="plant-code"
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="p-amb">{t('plants.col.ambient')}</Label>
            <Select
              value={v.ambientProfile}
              onValueChange={(x) => set('ambientProfile', x as 'hot' | 'moderate')}
            >
              <SelectTrigger id="p-amb" aria-label={t('plants.col.ambient')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="moderate">{t('plants.ambient.moderate')}</SelectItem>
                <SelectItem value="hot">{t('plants.ambient.hot')}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="p-en">{t('plants.nameEn')}</Label>
            <Input
              id="p-en"
              dir="ltr"
              value={v.nameEn}
              onChange={(e) => set('nameEn', e.target.value)}
              data-testid="plant-name-en"
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="p-ar">{t('plants.nameAr')}</Label>
            <Input
              id="p-ar"
              dir="rtl"
              lang="ar"
              value={v.nameAr}
              onChange={(e) => set('nameAr', e.target.value)}
              data-testid="plant-name-ar"
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="p-city">{t('plants.col.city')}</Label>
            <Input id="p-city" value={v.city} onChange={(e) => set('city', e.target.value)} />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="p-region">{t('plants.region')}</Label>
            <Input id="p-region" value={v.region} onChange={(e) => set('region', e.target.value)} />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="p-haul">{t('plants.haul')}</Label>
            <div className="flex items-center gap-2">
              <Input
                id="p-haul"
                dir="ltr"
                inputMode="decimal"
                value={v.haulCostJodPerM3Km}
                onChange={(e) => set('haulCostJodPerM3Km', e.target.value)}
              />
              <span className="shrink-0 text-xs text-muted">{t('plants.haulUnit')}</span>
            </div>
          </div>
          {plant && (
            <div className="flex items-center gap-2 self-end">
              <Switch
                checked={v.isActive}
                onCheckedChange={(c) => set('isActive', c)}
                id="p-active"
                aria-label={t('plants.col.active')}
              />
              <Label htmlFor="p-active">{t('plants.col.active')}</Label>
            </div>
          )}
        </div>
        {err && (
          <p role="alert" className="mt-3 text-sm text-fail-text" data-testid="plant-error">
            {err}
          </p>
        )}
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            {t('rules.cancel')}
          </Button>
          <Button disabled={!ok || m.isPending} onClick={() => m.mutate()} data-testid="plant-save">
            {t('plants.save')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function PlantsPage() {
  const { t } = useTranslation();
  const { lang } = usePrefs();
  const { data: me } = useMe();
  const canManage = (me?.capabilities ?? []).includes('org.manage');
  const plants = useQuery({ ...adminPlantsQuery, enabled: canManage });
  const settings = useQuery({ ...settingsQuery, enabled: canManage });
  const [edit, setEdit] = useState<AdminPlant | 'new' | null>(null);
  if (me && !canManage) return <SectionPage id="plants" />;
  const active = (plants.data ?? []).length;
  const max = settings.data?.maxPlants;

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-heading">{t('nav.plants')}</h1>
          <p className="mt-1 max-w-3xl text-sm text-muted">{t('plants.intro')}</p>
          {max !== undefined && (
            <p className="mt-1 text-xs text-muted" data-testid="plant-count">
              {t('plants.count', { count: active, max })}
            </p>
          )}
        </div>
        <Button
          onClick={() => setEdit('new')}
          disabled={max !== undefined && active >= max}
          data-testid="new-plant"
        >
          <Plus className="size-4" aria-hidden />
          {t('plants.new')}
        </Button>
      </header>
      {plants.isLoading && <Skeleton className="h-24 w-full" />}
      {plants.data && plants.data.length === 0 && (
        <EmptyState
          icon={<Factory className="size-8" aria-hidden />}
          title={t('plants.empty.title')}
          description={t('plants.empty.description')}
        />
      )}
      {plants.data && plants.data.length > 0 && (
        <Table data-testid="plants-table">
          <caption className="sr-only">{t('nav.plants')}</caption>
          <thead>
            <tr>
              <Th>{t('plants.col.code')}</Th>
              <Th>{t('plants.col.name')}</Th>
              <Th className="hidden md:table-cell">{t('plants.col.city')}</Th>
              <Th className="hidden md:table-cell">{t('plants.col.ambient')}</Th>
              <Th>{t('plants.col.active')}</Th>
              <Th>
                <span className="sr-only">{t('plants.edit')}</span>
              </Th>
            </tr>
          </thead>
          <tbody>
            {plants.data.map((p) => (
              <tr key={p.id} data-testid="plant-row">
                <Td>
                  <Ltr mono>{p.code}</Ltr>
                </Td>
                <Td>{lang === 'ar' ? p.nameAr : p.nameEn}</Td>
                <Td className="hidden md:table-cell">{p.city ?? '–'}</Td>
                <Td className="hidden md:table-cell">{t(`plants.ambient.${p.ambientProfile}`)}</Td>
                <Td>{p.isActive ? t('plants.active') : t('plants.inactive')}</Td>
                <Td>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={t('plants.editNamed', { name: p.code })}
                    onClick={() => setEdit(p)}
                  >
                    <Pencil className="size-4" aria-hidden />
                  </Button>
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      {edit && (
        <PlantDialog
          key={edit === 'new' ? 'new' : edit.id}
          plant={edit === 'new' ? null : edit}
          onClose={() => setEdit(null)}
        />
      )}
    </div>
  );
}
