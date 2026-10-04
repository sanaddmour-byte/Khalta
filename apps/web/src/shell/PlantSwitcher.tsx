import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Ltr } from '@khalta/ui';
import { Factory } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { ALL, usePlant } from '../lib/plant';
import { usePrefs } from '../lib/prefs';
import { useGuardedSwitch } from '../lib/unsaved';

export function PlantSwitcher({ unscoped }: { unscoped: boolean }) {
  const { t } = useTranslation();
  const { lang } = usePrefs();
  const { plants, selected, select, loading } = usePlant();
  const guarded = useGuardedSwitch(select);

  if (!loading && !unscoped && plants.length === 0)
    return (
      <span className="flex items-center gap-2 text-sm text-muted" data-testid="plant-switcher">
        <Factory className="size-4" aria-hidden />
        {t('shell.noPlants')}
      </span>
    );

  return (
    <>
      <Select value={selected} onValueChange={guarded.request} disabled={loading}>
        <SelectTrigger
          aria-label={t('shell.plant')}
          data-testid="plant-switcher"
          className="h-9 w-40 sm:w-52"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {unscoped && <SelectItem value={ALL}>{t('shell.allPlants')}</SelectItem>}
          {plants.map((p) => (
            <SelectItem key={p.id} value={p.id}>
              <Ltr>{p.code}</Ltr> {lang === 'ar' ? p.nameAr : p.nameEn}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {guarded.dialog}
    </>
  );
}
