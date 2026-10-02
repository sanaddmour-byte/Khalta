import {
  DEFAULT_FM_SIEVES,
  fineModulus,
  parseGradationPaste,
  validateGradation,
  type GradationPoint,
} from '@khalta/engine';
import {
  Button,
  Dialog,
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
  SheetContent,
  Textarea,
} from '@khalta/ui';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { AdHocMaterial } from './api';

type Cat = 'cement' | 'scm' | 'fine_agg' | 'coarse_agg' | 'water';
const CATS: Cat[] = ['cement', 'scm', 'fine_agg', 'coarse_agg', 'water'];
const PRICE = /^\d{1,9}(\.\d{1,3})?$/;

/**
 * Quick entry (07 §6): the minimum set for a what-if material that exists only inside this request. Its values are
 * labelled user-declared; it can never become a design until it is added to the library with a test and a price.
 */
export function AdHocDrawer({
  open,
  onOpenChange,
  onAdd,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onAdd: (m: AdHocMaterial) => void;
}) {
  const { t } = useTranslation();
  const [cat, setCat] = useState<Cat>('coarse_agg');
  const [nameEn, setNameEn] = useState('');
  const [nameAr, setNameAr] = useState('');
  const [sg, setSg] = useState('');
  const [c3a, setC3a] = useState('');
  const [scmType, setScmType] = useState('fly_ash');
  const [chlorides, setChlorides] = useState('');
  const [paste, setPaste] = useState('');
  const [price, setPrice] = useState('');

  const isAgg = cat === 'fine_agg' || cat === 'coarse_agg';
  const parsed = isAgg && paste.trim() ? parseGradationPaste(paste) : null;
  const points: GradationPoint[] = parsed?.points ?? [];
  const gradErrors = points.length ? validateGradation(points).map((e) => e.message) : [];
  const fm = points.length ? fineModulus(points, DEFAULT_FM_SIEVES) : null;
  const sgNum = Number(sg);
  const problems: string[] = [];
  if (!nameEn.trim()) problems.push('name');
  if (!(sgNum > 0)) problems.push('sg');
  if (isAgg && points.length < 2) problems.push('gradation');
  if (isAgg && (gradErrors.length > 0 || (parsed?.errors.length ?? 0) > 0))
    problems.push('gradation');
  if (price.trim() && !PRICE.test(price.trim())) problems.push('price');

  const submit = () => {
    const properties: Record<string, unknown> = {};
    if (isAgg) {
      properties['sg_ssd'] = sgNum;
      properties['sieve_analysis'] = points;
      if (chlorides.trim()) properties['chlorides_pct'] = Number(chlorides);
    } else {
      properties['sg'] = sgNum;
      if (cat === 'cement' && c3a.trim()) properties['c3a_pct'] = Number(c3a);
      if (cat === 'scm') properties['scm_type'] = scmType;
      if (cat === 'water' && chlorides.trim()) properties['chloride_mg_l'] = Number(chlorides);
    }
    onAdd({
      category: cat,
      market_name_en: nameEn.trim(),
      ...(nameAr.trim() && { market_name_ar: nameAr.trim() }),
      properties,
      ...(price.trim() && { price_jod_per_kg: price.trim() }),
    });
    setNameEn('');
    setNameAr('');
    setSg('');
    setPaste('');
    setPrice('');
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="end"
        className="flex flex-col gap-4 overflow-y-auto p-6"
        data-testid="adhoc-drawer"
      >
        <DialogTitle className="text-lg font-semibold text-heading">
          {t('studio.adhoc.title')}
        </DialogTitle>
        <DialogDescription className="text-sm text-muted">
          {t('studio.adhoc.hint')}
        </DialogDescription>
        <div className="flex flex-col gap-1">
          <Label htmlFor="adhoc-cat">{t('studio.adhoc.category')}</Label>
          <Select value={cat} onValueChange={(v) => setCat(v as Cat)}>
            <SelectTrigger id="adhoc-cat" data-testid="adhoc-category">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CATS.map((c) => (
                <SelectItem key={c} value={c}>
                  {t(`studio.pool.cat.${c}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="adhoc-en">{t('studio.adhoc.nameEn')}</Label>
          <Input
            id="adhoc-en"
            value={nameEn}
            onChange={(e) => setNameEn(e.target.value)}
            data-testid="adhoc-name-en"
            dir="ltr"
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="adhoc-ar">{t('studio.adhoc.nameAr')}</Label>
          <Input
            id="adhoc-ar"
            value={nameAr}
            onChange={(e) => setNameAr(e.target.value)}
            dir="rtl"
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="adhoc-sg">{isAgg ? t('studio.adhoc.sgSsd') : t('studio.adhoc.sg')}</Label>
          <Input
            id="adhoc-sg"
            inputMode="decimal"
            value={sg}
            onChange={(e) => setSg(e.target.value)}
            data-testid="adhoc-sg"
            dir="ltr"
          />
        </div>
        {cat === 'cement' && (
          <div className="flex flex-col gap-1">
            <Label htmlFor="adhoc-c3a">{t('studio.adhoc.c3a')}</Label>
            <Input
              id="adhoc-c3a"
              inputMode="decimal"
              value={c3a}
              onChange={(e) => setC3a(e.target.value)}
              dir="ltr"
            />
          </div>
        )}
        {cat === 'scm' && (
          <div className="flex flex-col gap-1">
            <Label htmlFor="adhoc-scm">{t('studio.adhoc.scmType')}</Label>
            <Select value={scmType} onValueChange={setScmType}>
              <SelectTrigger id="adhoc-scm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {['fly_ash', 'ggbs', 'silica_fume', 'natural_pozzolan'].map((s) => (
                  <SelectItem key={s} value={s}>
                    {t(`studio.adhoc.scm.${s}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
        {(isAgg || cat === 'water') && (
          <div className="flex flex-col gap-1">
            <Label htmlFor="adhoc-cl">
              {cat === 'water' ? t('studio.adhoc.chlorideMgL') : t('studio.adhoc.chloridePct')}
            </Label>
            <Input
              id="adhoc-cl"
              inputMode="decimal"
              value={chlorides}
              onChange={(e) => setChlorides(e.target.value)}
              dir="ltr"
            />
          </div>
        )}
        {isAgg && (
          <div className="flex flex-col gap-1">
            <Label htmlFor="adhoc-paste">{t('studio.adhoc.paste')}</Label>
            <Textarea
              id="adhoc-paste"
              rows={6}
              value={paste}
              onChange={(e) => setPaste(e.target.value)}
              placeholder={t('studio.adhoc.pastePlaceholder')}
              data-testid="adhoc-paste"
              dir="ltr"
            />
            {fm && fm.ok && (
              <p className="text-sm" data-testid="adhoc-fm">
                {t('studio.adhoc.fm')} <Ltr>{fm.fm.toFixed(2)}</Ltr>
              </p>
            )}
            {[...(parsed?.errors ?? []), ...gradErrors].map((e, i) => (
              <p key={i} role="alert" className="text-xs text-fail-text">
                {e}
              </p>
            ))}
          </div>
        )}
        <div className="flex flex-col gap-1">
          <Label htmlFor="adhoc-price">{t('studio.adhoc.price')}</Label>
          <Input
            id="adhoc-price"
            inputMode="decimal"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            data-testid="adhoc-price"
            dir="ltr"
          />
          <p className="text-xs text-muted">{t('studio.adhoc.priceHint')}</p>
        </div>
        <p className="rounded-md border border-warn bg-warn-bg p-2 text-xs text-warn-text">
          {t('studio.adhoc.declared')}
        </p>
        <Button disabled={problems.length > 0} onClick={submit} data-testid="adhoc-add">
          {t('studio.adhoc.add')}
        </Button>
      </SheetContent>
    </Dialog>
  );
}
