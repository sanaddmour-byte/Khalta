import {
  Button,
  Dialog,
  DialogClose,
  DialogDescription,
  DialogTitle,
  EmptyState,
  Ltr,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  SheetContent,
  Skeleton,
  Table,
  Td,
  Th,
} from '@khalta/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Layers, X } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../lib/api';
import { useMe } from '../lib/auth';
import { usePlant } from '../lib/plant';
import { usePrefs } from '../lib/prefs';
import { SectionPage } from '../pages/Section';
import { describeSpec } from '../studio/characteristics';
import {
  approveVersion,
  diffQuery,
  profileQuery,
  profilesQuery,
  usageQuery,
  type AppliesTo,
  type ProfileDetail,
  type ProfileRow,
  type VersionDetail,
} from './api';
import { draftOf, EMPTY_DRAFT, ProfileDialog } from './ProfileDialog';

const ALL = 'all';

function StatusPill({ status }: { status: 'draft' | 'approved' }) {
  const { t } = useTranslation();
  return (
    <span
      className={`rounded-md border px-2 py-0.5 text-xs font-medium ${status === 'approved' ? 'border-pass bg-pass-bg text-pass-text' : 'border-warn bg-warn-bg text-warn-text'}`}
      data-testid={`status-${status}`}
    >
      {t(`profiles.status.${status}`)}
    </span>
  );
}

/** "f′c 30–40 · XC1, XC2 · slab · summer" — what a profile applies to, or "any request". */
export function AppliesSummary({ a }: { a: AppliesTo }) {
  const { t } = useTranslation();
  const parts: string[] = [];
  if (a.fcMin !== undefined || a.fcMax !== undefined)
    parts.push(`f′c ${a.fcMin ?? '…'}–${a.fcMax ?? '…'}`);
  if (a.exposure?.length) parts.push(a.exposure.join(', '));
  if (a.pumpable) parts.push(t('profiles.form.pumpableOnly'));
  if (a.placement) parts.push(t(`profiles.placement.${a.placement}`));
  if (a.season) parts.push(t(`profiles.season.${a.season}`));
  return <>{parts.length ? parts.join(' · ') : t('profiles.appliesAny')}</>;
}

export function ProfilesPage() {
  const { t } = useTranslation();
  const { lang } = usePrefs();
  const { data: me } = useMe();
  const { plants } = usePlant();
  const caps = me?.capabilities ?? [];
  const canRead = caps.includes('design.write');
  const [scope, setScope] = useState(ALL);
  const [plant, setPlant] = useState(ALL);
  const [family, setFamily] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const { data, isLoading, isError } = useQuery({
    ...profilesQuery(scope === ALL ? undefined : scope, plant === ALL ? undefined : plant),
    enabled: canRead,
  });
  if (me && !canRead) return <SectionPage id="profiles" />;
  const nameOf = (p: { nameEn: string; nameAr: string }) => (lang === 'ar' ? p.nameAr : p.nameEn);
  const plantName = (id: string | null) => {
    const p = plants.find((x) => x.id === id);
    return p ? (lang === 'ar' ? p.nameAr : p.nameEn) : t('profiles.allPlants');
  };
  const rows = (data ?? []).filter(
    (p) => !family.trim() || (p.family ?? '').toLowerCase().includes(family.trim().toLowerCase()),
  );

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-heading">{t('nav.profiles')}</h1>
          <p className="mt-1 max-w-3xl text-sm text-muted">{t('profiles.intro')}</p>
        </div>
        <Button onClick={() => setCreating(true)} data-testid="new-profile">
          {t('profiles.new')}
        </Button>
      </header>

      <div className="flex flex-wrap items-end gap-3" role="search" aria-label={t('rules.filters')}>
        <Select value={scope} onValueChange={setScope}>
          <SelectTrigger aria-label={t('profiles.col.scope')} className="w-52">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>{t('profiles.allScopes')}</SelectItem>
            {(['tenant', 'plant', 'product_family'] as const).map((s) => (
              <SelectItem key={s} value={s}>
                {t(`profiles.scope.${s}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={plant} onValueChange={setPlant}>
          <SelectTrigger aria-label={t('profiles.col.plant')} className="w-52">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>{t('profiles.allPlants')}</SelectItem>
            {plants.map((p) => (
              <SelectItem key={p.id} value={p.id}>
                {lang === 'ar' ? p.nameAr : p.nameEn}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <input
          value={family}
          onChange={(e) => setFamily(e.target.value)}
          placeholder={t('profiles.familyFilter')}
          aria-label={t('profiles.familyFilter')}
          className="h-9 w-52 rounded-md border border-line bg-surface px-3 text-sm"
          data-testid="profile-family-filter"
        />
      </div>

      {isLoading && <Skeleton className="h-32 w-full" />}
      {isError && (
        <p role="alert" className="text-sm text-fail-text">
          {t('errors.loadFailed')}
        </p>
      )}
      {data && rows.length === 0 && (
        <EmptyState
          icon={<Layers className="size-8" aria-hidden />}
          title={t('profiles.empty.title')}
          description={t('profiles.empty.description')}
        />
      )}
      {rows.length > 0 && (
        <div className="overflow-x-auto">
          <Table data-testid="profiles-table">
            <caption className="sr-only">{t('nav.profiles')}</caption>
            <thead>
              <tr>
                <Th>{t('profiles.col.name')}</Th>
                <Th>{t('profiles.col.scope')}</Th>
                <Th className="hidden md:table-cell">{t('profiles.col.appliesTo')}</Th>
                <Th>{t('profiles.col.status')}</Th>
                <Th className="hidden lg:table-cell">{t('profiles.col.version')}</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p: ProfileRow) => (
                <tr
                  key={p.id}
                  className="border-t border-line hover:bg-primary-tint"
                  data-testid="profile-row"
                  data-name={p.nameEn}
                >
                  <Td>
                    <button
                      type="button"
                      className="text-start font-medium text-heading underline-offset-2 hover:underline"
                      onClick={() => setOpen(p.id)}
                    >
                      {nameOf(p)}
                    </button>
                  </Td>
                  <Td>
                    {t(`profiles.scope.${p.scope}`)}
                    {p.scope === 'plant' && <> · {plantName(p.plantId)}</>}
                    {p.scope === 'product_family' && p.family && <> · {p.family}</>}
                  </Td>
                  <Td className="hidden md:table-cell">
                    <AppliesSummary a={p.appliesTo} />
                  </Td>
                  <Td>
                    <div className="flex flex-wrap gap-1">
                      {p.approved && <StatusPill status="approved" />}
                      {p.latest.status === 'draft' && <StatusPill status="draft" />}
                    </div>
                  </Td>
                  <Td className="hidden lg:table-cell">
                    <Ltr>{t('versions.short', { n: p.latest.version })}</Ltr>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </div>
      )}

      {open && <ProfileSheet id={open} onClose={() => setOpen(null)} />}
      <ProfileDialog
        open={creating}
        onOpenChange={setCreating}
        initial={{ ...EMPTY_DRAFT, plantId: plants[0]?.id ?? null }}
        plants={plants}
        onSaved={(r) => setOpen(r.id)}
      />
    </div>
  );
}

function ContentView({ v }: { v: VersionDetail }) {
  const { t } = useTranslation();
  type Entry = [string, string, string | null, Record<string, unknown>];
  const entries: Entry[] = Object.entries(v.characteristics).flatMap(([key, spec]): Entry[] =>
    ['agg_kg', 'agg_share_pct', 'passing_pct'].includes(key)
      ? Object.entries(spec as Record<string, Record<string, unknown>>).map(([sub, s]): Entry => [
          `${key}.${sub}`,
          key,
          sub,
          s,
        ])
      : [[key, key, null, spec as Record<string, unknown>]],
  );
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm" data-testid="profile-content">
      <dt className="text-muted">{t('profiles.col.appliesTo')}</dt>
      <dd>
        <AppliesSummary a={v.appliesTo} />
      </dd>
      {v.objective && (
        <>
          <dt className="text-muted">{t('profiles.form.objective')}</dt>
          <dd>
            {t(
              v.objective === 'cheapest'
                ? 'studio.req.objective.cheapest'
                : 'studio.req.objective.closest',
            )}
          </dd>
        </>
      )}
      {v.mode && (
        <>
          <dt className="text-muted">{t('profiles.form.mode')}</dt>
          <dd>{v.mode}</dd>
        </>
      )}
      {entries.map(([id, key, sub, spec]) => (
        <div key={id} className="contents">
          <dt className="text-muted">
            {t(`studio.chars.${key}`)}
            {sub ? ` · ${sub}` : ''}
          </dt>
          <dd>
            <Ltr>{describeSpec(spec)}</Ltr>
          </dd>
        </div>
      ))}
      {v.materials.exclude?.length ? (
        <>
          <dt className="text-muted">{t('profiles.form.exclude')}</dt>
          <dd>
            <Ltr>{v.materials.exclude.length}</Ltr>
          </dd>
        </>
      ) : null}
    </dl>
  );
}

function CheckResults({ v }: { v: VersionDetail }) {
  const { t } = useTranslation();
  const results = v.check.results ?? [];
  if (results.length === 0) return <p className="text-sm text-muted">{t('profiles.check.none')}</p>;
  return (
    <ul className="flex flex-col gap-1 text-sm" data-testid="profile-check">
      {results.map((r) => (
        <li key={`${r.exposure}-${r.mode}`} className="flex flex-wrap gap-2">
          <Ltr>
            {r.exposure} · {r.mode}
          </Ltr>
          {r.ok ? (
            <span className="text-pass-text">{t('profiles.check.ok')}</span>
          ) : (
            <span className="text-fail-text">
              {t('profiles.check.rejected')}
              {r.rejected.map((x) => x.message ?? x.key).join('; ')}
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

function DiffView({ id, from, to }: { id: string; from: number; to: number }) {
  const { t } = useTranslation();
  const { data } = useQuery(diffQuery(id, from, to));
  if (!data) return <Skeleton className="h-12 w-full" />;
  if (data.rows.length === 0)
    return <p className="text-sm text-muted">{t('profiles.diff.none')}</p>;
  const show = (x: unknown) => (x === undefined || x === null ? '–' : JSON.stringify(x));
  return (
    <ul className="flex flex-col gap-1 text-sm" data-testid="profile-diff">
      {data.rows.map((r) => (
        <li key={r.key} className="flex flex-wrap gap-2">
          <Ltr mono>{r.key}</Ltr>
          <span className="text-muted">{t(`profiles.diff.${r.kind}`)}</span>
          <Ltr>
            {show(r.from)} → {show(r.to)}
          </Ltr>
        </li>
      ))}
    </ul>
  );
}

function ProfileSheet({ id, onClose }: { id: string; onClose: () => void }) {
  const { t } = useTranslation();
  const { lang } = usePrefs();
  const { data: me } = useMe();
  const { plants } = usePlant();
  const qc = useQueryClient();
  const { data: p } = useQuery(profileQuery(id));
  const { data: usage } = useQuery(usageQuery(id));
  const [sel, setSel] = useState<number | null>(null);
  const [editing, setEditing] = useState(false);
  const caps = me?.capabilities ?? [];
  const versions = p ? [...p.versions].sort((a, b) => b.version - a.version) : [];
  const current = versions.find((v) => v.version === sel) ?? versions[0];
  const approvedV = versions.find((v) => v.status === 'approved');
  const prev = current ? versions.find((v) => v.version === current.version - 1) : undefined;
  const isAuthor = !!current && current.createdBy === me?.user.id;
  const approve = useMutation({
    mutationFn: (v: number) => approveVersion(id, v),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['profiles'] });
      void qc.invalidateQueries({ queryKey: ['profile', id] });
    },
  });
  const err = approve.error instanceof ApiError ? approve.error.message : null;
  const canApprove = caps.includes('profile.approve') && current?.status === 'draft' && !isAuthor;
  const title = p ? (lang === 'ar' ? p.nameAr : p.nameEn) : '';

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <SheetContent
        side="end"
        className="w-[40rem] max-w-full overflow-y-auto"
        data-testid="profile-sheet"
      >
        <div className="mb-3 flex items-start justify-between gap-2">
          <div>
            <DialogTitle className="text-base font-semibold text-heading">
              {title || <Skeleton className="h-6 w-40" />}
            </DialogTitle>
            <DialogDescription className="mt-1 text-sm text-muted">
              {p ? t(`profiles.scope.${p.scope}`) : ''}
              {p?.scope === 'product_family' && p.family ? ` · ${p.family}` : ''}
            </DialogDescription>
          </div>
          <DialogClose asChild>
            <Button variant="ghost" size="icon" aria-label={t('ui.close')}>
              <X className="size-4" aria-hidden />
            </Button>
          </DialogClose>
        </div>
        {p && current && (
          <div className="flex flex-col gap-5">
            <section aria-label={t('profiles.versions')}>
              <h3 className="mb-2 text-sm font-semibold">{t('profiles.versions')}</h3>
              <ul className="flex flex-wrap gap-2" data-testid="profile-versions">
                {versions.map((v) => (
                  <li key={v.version}>
                    <button
                      type="button"
                      aria-pressed={v.version === current.version}
                      onClick={() => setSel(v.version)}
                      className={`flex items-center gap-2 rounded-md border px-2 py-1 text-xs ${v.version === current.version ? 'border-primary bg-primary-tint' : 'border-line'}`}
                      data-testid={`version-${v.version}`}
                    >
                      <Ltr>{t('versions.short', { n: v.version })}</Ltr>
                      <StatusPill status={v.status} />
                    </button>
                  </li>
                ))}
              </ul>
              {approvedV && current.status === 'draft' && (
                <p className="mt-2 text-xs text-muted">
                  {t('profiles.inForce', { version: approvedV.version })}
                </p>
              )}
            </section>

            <section aria-label={t('profiles.content')}>
              <ContentView v={current} />
              {current.changeNote && (
                <p className="mt-2 text-sm text-muted">{current.changeNote}</p>
              )}
            </section>

            <section aria-label={t('profiles.check.title')}>
              <h3 className="mb-2 text-sm font-semibold">{t('profiles.check.title')}</h3>
              <CheckResults v={current} />
            </section>

            {prev && (
              <section aria-label={t('profiles.diff.title')}>
                <h3 className="mb-2 text-sm font-semibold">
                  {t('profiles.diff.title', { from: prev.version, to: current.version })}
                </h3>
                <DiffView id={id} from={prev.version} to={current.version} />
              </section>
            )}

            <section aria-label={t('profiles.usage.title')} data-testid="profile-usage">
              <h3 className="mb-2 text-sm font-semibold">
                {t('profiles.usage.title', { n: usage?.designs.length ?? 0 })}
              </h3>
              {usage && usage.olderDesigns.length > 0 && (
                <p className="mb-1 text-sm text-warn-text">
                  {t('profiles.usage.older', { n: usage.olderDesigns.length })}
                </p>
              )}
              <ul className="flex flex-col gap-1 text-sm">
                {usage?.designs.map((d) => (
                  <li key={`${d.id}`}>
                    <Ltr mono>{d.code}</Ltr> ·{' '}
                    <Ltr>{t('versions.short', { n: d.profileVersion })}</Ltr>
                  </li>
                ))}
              </ul>
            </section>

            {err && (
              <p role="alert" className="text-sm text-fail-text" data-testid="approve-error">
                {err}
              </p>
            )}
            <div className="flex flex-wrap gap-3">
              {caps.includes('profile.approve') && current.status === 'draft' && (
                <Button
                  onClick={() => approve.mutate(current.version)}
                  disabled={!canApprove || approve.isPending || current.check.ok === false}
                  data-testid="approve-version"
                >
                  {t('profiles.approve')}
                </Button>
              )}
              {isAuthor && current.status === 'draft' && caps.includes('profile.approve') && (
                <p className="self-center text-xs text-muted">{t('profiles.approveOwn')}</p>
              )}
              <Button
                variant="secondary"
                onClick={() => setEditing(true)}
                data-testid="new-version"
              >
                {t('profiles.newVersion')}
              </Button>
            </div>
            <ProfileDialog
              open={editing}
              onOpenChange={setEditing}
              initial={draftOf(p as ProfileDetail, current)}
              versionOf={p.id}
              plants={plants}
              onSaved={(r) => setSel(r.version)}
            />
          </div>
        )}
      </SheetContent>
    </Dialog>
  );
}
