import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
} from '@khalta/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError, type Plant } from '../lib/api';
import { usePrefs } from '../lib/prefs';
import { preflight } from '../studio/api';
import { CharacteristicsPanel } from '../studio/CharacteristicsPanel';
import {
  buildCharacteristics,
  mapOfResolved,
  stateOfSpec,
  type CharMap,
} from '../studio/characteristics';
import { EXPOSURE } from '../studio/characteristics';
import {
  createProfile,
  createVersion,
  type AppliesTo,
  type ExposureCheck,
  type Scope,
} from './api';

export interface ProfileDraft {
  scope: Scope;
  plantId: string | null;
  nameAr: string;
  nameEn: string;
  family: string;
  appliesTo: AppliesTo;
  chars: CharMap;
  exclude: string[];
  objective: 'cheapest' | 'closest_to_targets' | null;
  mode: 'ACI' | 'JS' | 'BOTH' | null;
}
export const EMPTY_DRAFT: ProfileDraft = {
  scope: 'product_family',
  plantId: null,
  nameAr: '',
  nameEn: '',
  family: '',
  appliesTo: {},
  chars: {},
  exclude: [],
  objective: null,
  mode: null,
};

/** A saved version's content as the form's draft (so "new version" starts from what is in force). */
export function draftOf(
  p: {
    scope: Scope;
    plantId: string | null;
    nameAr: string;
    nameEn: string;
    family: string | null;
  },
  v: {
    appliesTo: AppliesTo;
    characteristics: Record<string, unknown>;
    materials: { exclude?: string[] };
    objective: ProfileDraft['objective'];
    mode: ProfileDraft['mode'];
  },
): ProfileDraft {
  const chars: CharMap = {};
  for (const [key, spec] of Object.entries(v.characteristics)) {
    if (['agg_kg', 'agg_share_pct', 'passing_pct'].includes(key))
      for (const [sub, s] of Object.entries(spec as Record<string, Record<string, unknown>>))
        chars[`${key}.${sub}`] = stateOfSpec(key, s);
    else chars[key] = stateOfSpec(key, spec as Record<string, unknown>);
  }
  return {
    ...p,
    family: p.family ?? '',
    appliesTo: v.appliesTo,
    chars,
    exclude: v.materials.exclude ?? [],
    objective: v.objective,
    mode: v.mode,
  };
}

const num = (s: string) => (s.trim() === '' || !Number.isFinite(Number(s)) ? undefined : Number(s));
const PLACEMENTS = ['slab', 'beam', 'column', 'wall', 'foundation', 'other'];
const SEASONS = ['summer', 'winter', 'all'];
const ANY = '__any__';

/**
 * Create a profile or a new version of one. The same characteristics rows as the Studio; a value that would
 * loosen a code limit is rejected inline, and the server checks every exposure the profile covers.
 */
export function ProfileDialog({
  open,
  onOpenChange,
  initial,
  versionOf,
  plants,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  initial: ProfileDraft;
  /** Set when saving a new version of an existing profile. */
  versionOf?: string | null;
  plants: Plant[];
  onSaved?: (r: {
    id: string;
    version: number;
    check: { ok: boolean; results: ExposureCheck[] };
  }) => void;
}) {
  const { t } = useTranslation();
  const { lang } = usePrefs();
  const qc = useQueryClient();
  const [d, setD] = useState(initial);
  const [note, setNote] = useState('');
  // reset the form when the dialog opens, not whenever the parent re-renders with a new `initial`
  const initialRef = useRef(initial);
  initialRef.current = initial;
  useEffect(() => {
    if (open) {
      setD(initialRef.current);
      setNote('');
    }
  }, [open]);
  const set = (p: Partial<ProfileDraft>) => setD((c) => ({ ...c, ...p }));
  const setApplies = (p: Partial<AppliesTo>) =>
    setD((c) => ({ ...c, appliesTo: { ...c.appliesTo, ...p } }));
  const refPlant = d.plantId ?? plants[0]?.id ?? '';
  const characteristics = buildCharacteristics(d.chars);
  const pf = useQuery({
    queryKey: [
      'profile-form-preflight',
      refPlant,
      d.appliesTo.exposure ?? [],
      d.appliesTo.fcMin ?? 30,
      JSON.stringify(characteristics),
    ],
    queryFn: () =>
      preflight({
        plantId: refPlant,
        mode: d.mode ?? 'ACI',
        requirements: {
          fcMpa: d.appliesTo.fcMin ?? d.appliesTo.fcMax ?? 30,
          basis: 'cylinder',
          testAgeDays: 28,
          exposure: d.appliesTo.exposure ?? [],
          slumpMm: 100,
          nmasMm: 19,
          pumpable: false,
          s3Option: null,
          airPct: null,
        },
        ...(Object.keys(characteristics).length > 0 && { characteristics }),
      }),
    enabled: open && !!refPlant,
    placeholderData: (p) => p,
    retry: false,
  });
  const pool = pf.data?.pool ?? [];
  const nameOf = (m: { nameEn: string; nameAr: string | null }) =>
    lang === 'ar' ? (m.nameAr ?? m.nameEn) : m.nameEn;

  const save = useMutation({
    mutationFn: () => {
      const content = {
        appliesTo: d.appliesTo,
        characteristics,
        materials: d.exclude.length ? { exclude: d.exclude } : {},
        objective: d.objective,
        mode: d.mode,
        ...(note.trim() && { changeNote: note.trim() }),
      };
      return versionOf
        ? createVersion(versionOf, content)
        : createProfile({
            ...content,
            scope: d.scope,
            plantId: d.scope === 'plant' ? d.plantId : null,
            nameAr: d.nameAr.trim(),
            nameEn: d.nameEn.trim(),
            family: d.family.trim() || null,
          });
    },
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['profiles'] });
      void qc.invalidateQueries({ queryKey: ['profile'] });
      onSaved?.(r);
      onOpenChange(false);
    },
  });
  const err = save.error instanceof ApiError ? save.error.message : null;
  const toggleExposure = (cls: string) =>
    setApplies({
      exposure: (d.appliesTo.exposure ?? []).includes(cls)
        ? (d.appliesTo.exposure ?? []).filter((x) => x !== cls)
        : [...(d.appliesTo.exposure ?? []), cls],
    });
  const valid =
    (versionOf || (d.nameEn.trim() && d.nameAr.trim() && (d.scope !== 'plant' || d.plantId))) &&
    true;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent closeLabel={t('ui.close')} className="max-w-3xl" data-testid="profile-dialog">
        <DialogTitle className="text-lg font-semibold text-heading">
          {versionOf ? t('profiles.dialog.newVersion') : t('profiles.dialog.create')}
        </DialogTitle>
        <DialogDescription className="text-sm text-muted">
          {t('profiles.dialog.hint')}
        </DialogDescription>
        <div className="mt-4 flex flex-col gap-5">
          {!versionOf && (
            <div className="grid gap-3 md:grid-cols-2">
              <div className="flex flex-col gap-1">
                <Label htmlFor="pf-en">{t('profiles.form.nameEn')}</Label>
                <Input
                  id="pf-en"
                  value={d.nameEn}
                  onChange={(e) => set({ nameEn: e.target.value })}
                  data-testid="profile-name-en"
                  dir="ltr"
                />
              </div>
              <div className="flex flex-col gap-1">
                <Label htmlFor="pf-ar">{t('profiles.form.nameAr')}</Label>
                <Input
                  id="pf-ar"
                  value={d.nameAr}
                  onChange={(e) => set({ nameAr: e.target.value })}
                  data-testid="profile-name-ar"
                  dir="rtl"
                />
              </div>
              <div className="flex flex-col gap-1">
                <Label htmlFor="pf-scope">{t('profiles.form.scope')}</Label>
                <Select value={d.scope} onValueChange={(v) => set({ scope: v as Scope })}>
                  <SelectTrigger id="pf-scope" data-testid="profile-scope">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(['tenant', 'plant', 'product_family'] as const).map((s) => (
                      <SelectItem key={s} value={s}>
                        {t(`profiles.scope.${s}`)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              {d.scope === 'plant' && (
                <div className="flex flex-col gap-1">
                  <Label htmlFor="pf-plant">{t('profiles.form.plant')}</Label>
                  <Select value={d.plantId ?? ''} onValueChange={(v) => set({ plantId: v })}>
                    <SelectTrigger id="pf-plant" data-testid="profile-plant">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {plants.map((p) => (
                        <SelectItem key={p.id} value={p.id}>
                          {lang === 'ar' ? p.nameAr : p.nameEn}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
              {d.scope === 'product_family' && (
                <div className="flex flex-col gap-1">
                  <Label htmlFor="pf-family">{t('profiles.form.family')}</Label>
                  <Input
                    id="pf-family"
                    value={d.family}
                    onChange={(e) => set({ family: e.target.value })}
                    data-testid="profile-family"
                  />
                </div>
              )}
            </div>
          )}

          <fieldset className="flex flex-col gap-3" data-testid="applies-to">
            <legend className="text-sm font-semibold">{t('profiles.form.appliesTo')}</legend>
            <p className="text-xs text-muted">{t('profiles.form.appliesHint')}</p>
            <div className="flex flex-wrap items-end gap-3">
              <div className="flex flex-col gap-1">
                <Label htmlFor="pf-fcmin">{t('profiles.form.fcMin')}</Label>
                <Input
                  id="pf-fcmin"
                  className="w-24"
                  inputMode="decimal"
                  value={d.appliesTo.fcMin ?? ''}
                  onChange={(e) => setApplies({ fcMin: num(e.target.value) })}
                  data-testid="applies-fcmin"
                  dir="ltr"
                />
              </div>
              <div className="flex flex-col gap-1">
                <Label htmlFor="pf-fcmax">{t('profiles.form.fcMax')}</Label>
                <Input
                  id="pf-fcmax"
                  className="w-24"
                  inputMode="decimal"
                  value={d.appliesTo.fcMax ?? ''}
                  onChange={(e) => setApplies({ fcMax: num(e.target.value) })}
                  dir="ltr"
                />
              </div>
              <div className="flex items-center gap-2">
                <Switch
                  id="pf-pump"
                  checked={d.appliesTo.pumpable === true}
                  onCheckedChange={(v) => setApplies({ pumpable: v ? true : undefined })}
                />
                <Label htmlFor="pf-pump">{t('profiles.form.pumpableOnly')}</Label>
              </div>
              <div className="flex flex-col gap-1">
                <Label htmlFor="pf-place">{t('profiles.form.placement')}</Label>
                <Select
                  value={d.appliesTo.placement ?? ANY}
                  onValueChange={(v) => setApplies({ placement: v === ANY ? undefined : v })}
                >
                  <SelectTrigger id="pf-place" className="w-36">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={ANY}>{t('profiles.form.any')}</SelectItem>
                    {PLACEMENTS.map((p) => (
                      <SelectItem key={p} value={p}>
                        {t(`profiles.placement.${p}`)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex flex-col gap-1">
                <Label htmlFor="pf-season">{t('profiles.form.season')}</Label>
                <Select
                  value={d.appliesTo.season ?? ANY}
                  onValueChange={(v) => setApplies({ season: v === ANY ? undefined : v })}
                >
                  <SelectTrigger id="pf-season" className="w-32">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={ANY}>{t('profiles.form.any')}</SelectItem>
                    {SEASONS.map((p) => (
                      <SelectItem key={p} value={p}>
                        {t(`profiles.season.${p}`)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div
              className="flex flex-wrap gap-2"
              role="group"
              aria-label={t('profiles.form.exposure')}
            >
              {Object.values(EXPOSURE)
                .flat()
                .map((cls) => {
                  const on = (d.appliesTo.exposure ?? []).includes(cls);
                  return (
                    <button
                      key={cls}
                      type="button"
                      aria-pressed={on}
                      onClick={() => toggleExposure(cls)}
                      data-testid={`applies-exposure-${cls}`}
                      className={`rounded-md border px-2 py-1 text-xs focus-visible:outline-2 focus-visible:outline-primary ${on ? 'border-primary bg-primary-tint' : 'border-line'}`}
                    >
                      {cls}
                    </button>
                  );
                })}
            </div>
          </fieldset>

          <div className="flex flex-wrap gap-3">
            <div className="flex flex-col gap-1">
              <Label htmlFor="pf-obj">{t('profiles.form.objective')}</Label>
              <Select
                value={d.objective ?? ANY}
                onValueChange={(v) =>
                  set({ objective: v === ANY ? null : (v as ProfileDraft['objective']) })
                }
              >
                <SelectTrigger id="pf-obj" className="w-60">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ANY}>{t('profiles.form.noDefault')}</SelectItem>
                  <SelectItem value="cheapest">{t('studio.req.objective.cheapest')}</SelectItem>
                  <SelectItem value="closest_to_targets">
                    {t('studio.req.objective.closest')}
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="pf-mode">{t('profiles.form.mode')}</Label>
              <Select
                value={d.mode ?? ANY}
                onValueChange={(v) => set({ mode: v === ANY ? null : (v as ProfileDraft['mode']) })}
              >
                <SelectTrigger id="pf-mode" className="w-48">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ANY}>{t('profiles.form.noDefault')}</SelectItem>
                  <SelectItem value="BOTH">{t('evaluation.options.both')}</SelectItem>
                  <SelectItem value="ACI">{t('evaluation.options.aci')}</SelectItem>
                  <SelectItem value="JS">{t('evaluation.options.js')}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <section className="flex flex-col gap-2" aria-label={t('profiles.form.exclude')}>
            <h4 className="text-sm font-semibold">{t('profiles.form.exclude')}</h4>
            <ul className="flex flex-wrap gap-2">
              {pool.map((m) => {
                const on = d.exclude.includes(m.id);
                return (
                  <li key={m.id}>
                    <button
                      type="button"
                      aria-pressed={on}
                      onClick={() =>
                        set({
                          exclude: on ? d.exclude.filter((x) => x !== m.id) : [...d.exclude, m.id],
                        })
                      }
                      className={`rounded-md border px-2 py-1 text-xs ${on ? 'border-fail bg-fail-bg text-fail-text line-through' : 'border-line'}`}
                    >
                      {nameOf(m)}
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>

          <CharacteristicsPanel
            pool={pool}
            map={d.chars}
            onChange={(chars) => set({ chars })}
            bounds={pf.data?.bounds ?? []}
            rejected={pf.data?.characteristics.rejected ?? []}
            nameOf={nameOf}
          />
          {versionOf && (
            <div className="flex flex-col gap-1">
              <Label htmlFor="pf-note">{t('profiles.form.note')}</Label>
              <Input
                id="pf-note"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                data-testid="profile-note"
              />
            </div>
          )}
          {err && (
            <p role="alert" className="text-sm text-fail-text" data-testid="profile-error">
              {err}
            </p>
          )}
          <div className="flex gap-3">
            <Button
              onClick={() => save.mutate()}
              disabled={!valid || save.isPending || (pf.data ? !pf.data.characteristics.ok : false)}
              data-testid="profile-save"
            >
              {t('profiles.form.saveDraft')}
            </Button>
            <Button variant="secondary" onClick={() => onOpenChange(false)}>
              {t('profiles.form.cancel')}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export { mapOfResolved };
