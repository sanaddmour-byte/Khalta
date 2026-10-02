import {
  Button,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@khalta/ui';
import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { usePrefs } from '../lib/prefs';
import { matchProfiles, type Brief, type MatchBody, type MatchResult } from '../profiles/api';
import type { RequestBody } from './api';

export const PLACEMENTS = ['slab', 'beam', 'column', 'wall', 'foundation', 'other'];
export const SEASONS = ['summer', 'winter', 'all'];
const ANY = '__any__';

export interface ProfileMatch {
  /** Profiles that apply to this request (suggested, also matched, tie candidates). */
  briefs: Brief[];
  suggested: Brief[];
  ties: MatchResult['ties'];
  /** The merged result of the selected profiles (with explicit ids). */
  applied: MatchResult | null;
  /** Readable "name v3" for a profile id, or null when unknown. */
  labelOf: (profileId: string) => string | null;
}

/** Suggestions for the current request, and the effect of the selected profiles on its characteristics. */
export function useProfileMatch(
  body: RequestBody | null,
  selected: string[],
  placement: string | null,
  season: string | null,
  enabled: boolean,
): ProfileMatch {
  const { lang } = usePrefs();
  const base: MatchBody | null = body && {
    plantId: body.plantId,
    fcMpa: body.requirements.fcMpa,
    exposure: body.requirements.exposure,
    pumpable: body.requirements.pumpable,
    placement,
    season,
    mode: body.mode,
  };
  const suggest = useQuery({
    queryKey: ['profile-match', JSON.stringify(base)],
    queryFn: () => matchProfiles(base!),
    enabled: enabled && base !== null,
    placeholderData: (p) => p,
    retry: false,
  });
  const applied = useQuery({
    queryKey: ['profile-applied', JSON.stringify(base), selected],
    queryFn: () => matchProfiles({ ...base!, profileIds: selected }),
    enabled: enabled && base !== null && selected.length > 0,
    placeholderData: (p) => p,
    retry: false,
  });
  return useMemo(() => {
    const s = suggest.data;
    const briefs = s ? [...s.chosen, ...s.alsoMatched, ...s.ties.flatMap((t) => t.candidates)] : [];
    const seen = new Set<string>();
    const unique = briefs.filter((b) => (seen.has(b.profileId) ? false : !!seen.add(b.profileId)));
    return {
      briefs: unique,
      suggested: s?.chosen ?? [],
      ties: s?.ties ?? [],
      applied: selected.length > 0 ? (applied.data ?? null) : null,
      labelOf: (id: string) => {
        const b = unique.find((x) => x.profileId === id);
        return b ? `${b.name} v${b.version}` : null;
      },
    };
  }, [suggest.data, applied.data, selected, lang]);
}

/** Which profiles apply here, with the choice left to the user when several match at one scope. */
export function ProfilePicker({
  match,
  selected,
  onChange,
  placement,
  season,
  onPlacement,
  onSeason,
}: {
  match: ProfileMatch;
  selected: string[];
  onChange: (ids: string[]) => void;
  placement: string | null;
  season: string | null;
  onPlacement: (v: string | null) => void;
  onSeason: (v: string | null) => void;
}) {
  const { t } = useTranslation();
  const tieIds = new Set(match.ties.flatMap((x) => x.candidates.map((c) => c.profileId)));
  const toggle = (b: Brief) => {
    const on = selected.includes(b.profileId);
    if (on) return onChange(selected.filter((x) => x !== b.profileId));
    // one profile per scope: picking one replaces another of the same scope
    const sameScope = match.briefs.filter((x) => x.scope === b.scope).map((x) => x.profileId);
    onChange([...selected.filter((x) => !sameScope.includes(x)), b.profileId].slice(-3));
  };
  return (
    <section
      className="flex flex-col gap-3"
      aria-labelledby="profile-picker-title"
      data-testid="profile-picker"
    >
      <h2 id="profile-picker-title" className="text-lg font-semibold text-heading">
        {t('studio.profiles.title')}
      </h2>
      <p className="max-w-3xl text-sm text-muted">{t('studio.profiles.hint')}</p>
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1">
          <Label htmlFor="sp-place">{t('profiles.form.placement')}</Label>
          <Select value={placement ?? ANY} onValueChange={(v) => onPlacement(v === ANY ? null : v)}>
            <SelectTrigger id="sp-place" className="w-36">
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
          <Label htmlFor="sp-season">{t('profiles.form.season')}</Label>
          <Select value={season ?? ANY} onValueChange={(v) => onSeason(v === ANY ? null : v)}>
            <SelectTrigger id="sp-season" className="w-32">
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
        {match.suggested.length > 0 && (
          <Button
            variant="secondary"
            onClick={() => onChange(match.suggested.map((b) => b.profileId))}
            data-testid="profiles-apply-suggested"
          >
            {t('studio.profiles.applySuggested')}
          </Button>
        )}
        {selected.length > 0 && (
          <Button variant="ghost" onClick={() => onChange([])} data-testid="profiles-clear">
            {t('studio.profiles.clear')}
          </Button>
        )}
      </div>
      {match.briefs.length === 0 ? (
        <p className="text-sm text-muted" data-testid="profiles-none">
          {t('studio.profiles.none')}
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {match.briefs.map((b) => (
            <li key={b.profileId}>
              <label className="flex flex-wrap items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={selected.includes(b.profileId)}
                  onChange={() => toggle(b)}
                  data-testid={`profile-pick-${b.name}`}
                />
                <span className="font-medium">{b.name}</span>
                <span className="text-muted">
                  {t('versions.short', { n: b.version })} · {t(`profiles.scope.${b.scope}`)}
                  {b.family ? ` · ${b.family}` : ''}
                </span>
                {b.status === 'draft' && (
                  <span className="rounded-md border border-warn bg-warn-bg px-2 py-0.5 text-xs text-warn-text">
                    {t('profiles.status.draft')}
                  </span>
                )}
                {tieIds.has(b.profileId) && (
                  <span className="text-xs text-muted">{t('studio.profiles.tie')}</span>
                )}
              </label>
            </li>
          ))}
        </ul>
      )}
      {match.applied?.hasDraft && (
        <p
          role="status"
          className="rounded-md border border-warn bg-warn-bg px-3 py-2 text-sm text-warn-text"
          data-testid="profiles-draft-warning"
        >
          {t('studio.profiles.draftBlocks')}
        </p>
      )}
    </section>
  );
}
