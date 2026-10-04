import { ROLES, type Role } from '@khalta/rbac';
import {
  Button,
  Checkbox,
  Dialog,
  DialogContent,
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
  Skeleton,
  Switch,
  Table,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Td,
  Th,
  toast,
} from '@khalta/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, Plus, UserMinus } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../lib/api';
import { useMe } from '../lib/auth';
import { usePrefs } from '../lib/prefs';
import { SectionPage } from '../pages/Section';
import {
  adminPlantsQuery,
  createUser,
  deactivateUser,
  resetPassword,
  saveSettings,
  setUserPlants,
  settingsQuery,
  updateUser,
  usersQuery,
  type AdminUser,
  type TenantSettings,
} from './api';

const num = (s: string): number | null =>
  s.trim() === '' || Number.isNaN(Number(s)) ? null : Number(s);

function GeneralTab() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { data: me } = useMe();
  // Administrative keys need org.manage; every other key shapes evidence and acceptance and needs engineering authority
  const canAdmin = me?.capabilities.includes('org.manage') ?? false;
  const canEng = me?.capabilities.includes('config.engineering') ?? false;
  const { data } = useQuery(settingsQuery);
  const [s, setS] = useState<TenantSettings | null>(null);
  const [text, setText] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!data) return;
    setS(data);
    setText({
      maxPlants: String(data.maxPlants),
      stalePriceDays: data.stalePriceDays === null ? '' : String(data.stalePriceDays),
      nearLimitPct: data.nearLimitPct === null ? '' : String(data.nearLimitPct),
      safetyMarginMpa: data.safetyMarginMpa === null ? '' : String(data.safetyMarginMpa),
      yieldTolerance: String(data.yieldTolerance),
      insightMinSavingJodPerM3: String(data.insightMinSavingJodPerM3),
      insightMinAnnualJod: String(data.insightMinAnnualJod),
      sg_min: String(data.sanityRanges['aggregate_sg_ssd']?.min ?? ''),
      sg_max: String(data.sanityRanges['aggregate_sg_ssd']?.max ?? ''),
      abs_min: String(data.sanityRanges['aggregate_absorption_pct']?.min ?? ''),
      abs_max: String(data.sanityRanges['aggregate_absorption_pct']?.max ?? ''),
      lh_nameEn: data.letterhead?.nameEn ?? '',
      lh_nameAr: data.letterhead?.nameAr ?? '',
      lh_addressEn: data.letterhead?.addressEn ?? '',
      lh_addressAr: data.letterhead?.addressAr ?? '',
    });
  }, [data]);
  const m = useMutation({
    mutationFn: (body: Partial<TenantSettings>) => saveSettings(body),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['settings'] });
      await qc.invalidateQueries({ queryKey: ['me'] });
      toast.success(t('settings.saved'));
    },
  });
  if (!s) return <Skeleton className="h-40 w-full" />;
  const range = (a: string, b: string) => {
    const min = num(text[a] ?? '');
    const max = num(text[b] ?? '');
    return { ...(min !== null && { min }), ...(max !== null && { max }) };
  };
  const valid =
    num(text['maxPlants'] ?? '') !== null &&
    num(text['insightMinSavingJodPerM3'] ?? '') !== null &&
    num(text['insightMinAnnualJod'] ?? '') !== null;
  const submit = () =>
    m.mutate({
      maxPlants: num(text['maxPlants'] ?? '') ?? s.maxPlants,
      salesCanViewCost: s.salesCanViewCost,
      numberFormat: s.numberFormat,
      stalePriceDays: num(text['stalePriceDays'] ?? ''),
      nearLimitPct: num(text['nearLimitPct'] ?? ''),
      safetyMarginMpa: num(text['safetyMarginMpa'] ?? ''),
      yieldTolerance: num(text['yieldTolerance'] ?? '') ?? s.yieldTolerance,
      insightMinSavingJodPerM3: num(text['insightMinSavingJodPerM3'] ?? '') ?? 0,
      insightMinAnnualJod: num(text['insightMinAnnualJod'] ?? '') ?? 0,
      approvalRequiresLabSource: s.approvalRequiresLabSource,
      admixtureSolutionWater: s.admixtureSolutionWater,
      letterhead:
        (text['lh_nameEn'] ?? '').trim() && (text['lh_nameAr'] ?? '').trim()
          ? {
              nameEn: (text['lh_nameEn'] ?? '').trim(),
              nameAr: (text['lh_nameAr'] ?? '').trim(),
              addressEn: (text['lh_addressEn'] ?? '').trim(),
              addressAr: (text['lh_addressAr'] ?? '').trim(),
              logoDataUrl: s.letterhead?.logoDataUrl ?? null,
            }
          : null,
      sanityRanges: {
        ...s.sanityRanges,
        aggregate_sg_ssd: range('sg_min', 'sg_max'),
        aggregate_absorption_pct: range('abs_min', 'abs_max'),
      },
    });
  const field = (k: string, label: string, unit?: string, eng = false) => (
    <div className="flex flex-col gap-1">
      <Label htmlFor={`s-${k}`}>{label}</Label>
      <div className="flex items-center gap-2">
        <Input
          id={`s-${k}`}
          data-testid={`s-${k}`}
          dir="ltr"
          inputMode="decimal"
          disabled={eng ? !canEng : !canAdmin}
          value={text[k] ?? ''}
          onChange={(e) => setText((x) => ({ ...x, [k]: e.target.value }))}
        />
        {unit && <Ltr className="shrink-0 text-xs text-muted">{unit}</Ltr>}
      </div>
    </div>
  );
  return (
    <form
      className="flex max-w-3xl flex-col gap-6"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      {!(canAdmin && canEng) && (
        <p
          className="rounded-md bg-olive-tint p-3 text-sm text-olive-text"
          data-testid="settings-authority-note"
        >
          {canAdmin ? t('settings.authority.adminOnly') : t('settings.authority.engineeringOnly')}
        </p>
      )}
      <section className="grid grid-cols-1 gap-4 sm:grid-cols-2" aria-label={t('settings.general')}>
        {field('maxPlants', t('settings.maxPlants'))}
        {field('stalePriceDays', t('settings.stalePriceDays'), t('settings.days'))}
        {field('nearLimitPct', t('settings.nearLimitPct'), t('settings.unit.pct'), true)}
        {field('safetyMarginMpa', t('settings.safetyMarginMpa'), t('settings.unit.mpa'), true)}
        {field('yieldTolerance', t('settings.yieldTolerance'), t('settings.unit.m3'), true)}
        {field('insightMinSavingJodPerM3', t('settings.insightMinSaving'), 'JOD/m³')}
        {field('insightMinAnnualJod', t('settings.insightMinAnnual'), 'JOD')}
        <div className="flex flex-col gap-1">
          <Label htmlFor="s-numfmt">{t('settings.numberFormat')}</Label>
          <Select
            value={s.numberFormat}
            onValueChange={(v) => setS({ ...s, numberFormat: v as TenantSettings['numberFormat'] })}
            disabled={!canAdmin}
          >
            <SelectTrigger id="s-numfmt" aria-label={t('settings.numberFormat')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="latin">{t('settings.digits.latin')}</SelectItem>
              <SelectItem value="arabic-indic">{t('settings.digits.arabic-indic')}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-center gap-2 self-end">
          <Switch
            id="s-sales"
            checked={s.salesCanViewCost}
            onCheckedChange={(c) => setS({ ...s, salesCanViewCost: c })}
            aria-label={t('settings.salesCanViewCost')}
            disabled={!canAdmin}
          />
          <Label htmlFor="s-sales">{t('settings.salesCanViewCost')}</Label>
        </div>
      </section>

      <section className="flex flex-col gap-4" aria-label={t('settings.materials')}>
        <div>
          <h3 className="text-sm font-semibold text-heading">{t('settings.materials')}</h3>
          <p className="text-xs text-muted">{t('settings.sanityHint')}</p>
        </div>
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          {field('sg_min', t('settings.sgMin'), undefined, true)}
          {field('sg_max', t('settings.sgMax'), undefined, true)}
          {field('abs_min', t('settings.absMin'), '%', true)}
          {field('abs_max', t('settings.absMax'), '%', true)}
        </div>
        <div className="flex items-start gap-2">
          <Checkbox
            id="s-lab"
            checked={s.approvalRequiresLabSource}
            onCheckedChange={(c) => setS({ ...s, approvalRequiresLabSource: c === true })}
            className="mt-0.5"
            disabled={!canEng}
          />
          <div>
            <Label htmlFor="s-lab">{t('settings.requiresLab')}</Label>
            <p className="text-xs text-muted">{t('settings.requiresLabHint')}</p>
          </div>
        </div>
      </section>

      <section className="flex flex-col gap-4" aria-label={t('settings.production')}>
        <div>
          <h3 className="text-sm font-semibold text-heading">{t('settings.production')}</h3>
          <p className="text-xs text-muted">{t('settings.productionHint')}</p>
        </div>
        <div className="flex items-start gap-2">
          <Checkbox
            id="s-sol"
            checked={s.admixtureSolutionWater}
            onCheckedChange={(c) => setS({ ...s, admixtureSolutionWater: c === true })}
            className="mt-0.5"
            data-testid="s-solution-water"
            disabled={!canEng}
          />
          <div>
            <Label htmlFor="s-sol">{t('settings.solutionWater')}</Label>
            <p className="text-xs text-muted">{t('settings.solutionWaterHint')}</p>
          </div>
        </div>
        <div>
          <h4 className="text-sm font-medium">{t('settings.letterhead')}</h4>
          <p className="text-xs text-muted">{t('settings.letterheadHint')}</p>
        </div>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {(['nameEn', 'nameAr', 'addressEn', 'addressAr'] as const).map((k) => (
            <div key={k} className="flex flex-col gap-1">
              <Label htmlFor={`s-lh_${k}`}>{t(`settings.lh.${k}`)}</Label>
              <Input
                id={`s-lh_${k}`}
                data-testid={`s-lh_${k}`}
                dir={k.endsWith('Ar') ? 'rtl' : 'ltr'}
                value={text[`lh_${k}`] ?? ''}
                disabled={!canAdmin}
                onChange={(e) => setText((x) => ({ ...x, [`lh_${k}`]: e.target.value }))}
              />
            </div>
          ))}
        </div>
      </section>

      {m.error instanceof ApiError && (
        <p role="alert" className="text-sm text-fail-text">
          {m.error.message}
        </p>
      )}
      <div>
        <Button type="submit" disabled={!valid || m.isPending} data-testid="settings-save">
          {t('settings.save')}
        </Button>
      </div>
    </form>
  );
}

function NewUserDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [v, setV] = useState({ name: '', email: '', role: 'viewer' as Role, password: '' });
  const m = useMutation({
    mutationFn: () => createUser({ ...v, name: v.name.trim(), email: v.email.trim() }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['users'] });
      toast.success(t('users.created'));
      onClose();
    },
  });
  const err = m.error instanceof ApiError ? m.error.message : null;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent closeLabel={t('ui.close')} className="max-w-lg" data-testid="user-dialog">
        <DialogTitle className="mb-1 text-lg font-semibold text-heading">
          {t('users.new')}
        </DialogTitle>
        <DialogDescription className="mb-4 text-sm text-muted">
          {t('users.newHint')}
        </DialogDescription>
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <Label htmlFor="u-name">{t('users.col.name')}</Label>
            <Input
              id="u-name"
              value={v.name}
              onChange={(e) => setV({ ...v, name: e.target.value })}
              data-testid="user-name"
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="u-email">{t('users.col.email')}</Label>
            <Input
              id="u-email"
              type="email"
              dir="ltr"
              value={v.email}
              onChange={(e) => setV({ ...v, email: e.target.value })}
              data-testid="user-email"
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="u-role">{t('users.col.role')}</Label>
            <Select value={v.role} onValueChange={(r) => setV({ ...v, role: r as Role })}>
              <SelectTrigger id="u-role" aria-label={t('users.col.role')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ROLES.map((r) => (
                  <SelectItem key={r} value={r}>
                    {t(`roles.${r}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="u-pw">{t('users.password')}</Label>
            <Input
              id="u-pw"
              type="password"
              dir="ltr"
              autoComplete="new-password"
              value={v.password}
              onChange={(e) => setV({ ...v, password: e.target.value })}
              data-testid="user-password"
            />
            <p className="text-xs text-muted">{t('users.passwordHint')}</p>
          </div>
        </div>
        {err && (
          <p role="alert" className="mt-3 text-sm text-fail-text">
            {err}
          </p>
        )}
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            {t('rules.cancel')}
          </Button>
          <Button
            disabled={!v.name.trim() || !v.email.trim() || v.password.length < 8 || m.isPending}
            onClick={() => m.mutate()}
            data-testid="user-save"
          >
            {t('users.create')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function UserDialog({ user, onClose }: { user: AdminUser; onClose: () => void }) {
  const { t } = useTranslation();
  const { lang } = usePrefs();
  const qc = useQueryClient();
  const { data: me } = useMe();
  const plants = useQuery(adminPlantsQuery);
  const [role, setRole] = useState<Role>(user.role);
  const [ids, setIds] = useState<string[]>(user.plantIds);
  const [pw, setPw] = useState('');
  const [reason, setReason] = useState('');
  const refresh = () => qc.invalidateQueries({ queryKey: ['users'] });
  const save = useMutation({
    mutationFn: async () => {
      if (role !== user.role)
        await updateUser(user.id, { role, ...(reason.trim() ? { reason: reason.trim() } : {}) });
      await setUserPlants(user.id, ids);
    },
    onSuccess: async () => {
      await refresh();
      toast.success(t('users.saved'));
      onClose();
    },
  });
  const reset = useMutation({
    mutationFn: () => resetPassword(user.id, pw),
    onSuccess: () => {
      setPw('');
      toast.success(t('users.passwordReset'));
    },
  });
  const off = useMutation({
    mutationFn: () => deactivateUser(user.id),
    onSuccess: async () => {
      await refresh();
      toast.success(t('users.deactivated'));
      onClose();
    },
  });
  const err = [save.error, reset.error, off.error].find(
    (e): e is ApiError => e instanceof ApiError,
  )?.message;
  const self = me?.user.id === user.id;
  const ENG = ['qc_manager', 'qc_engineer'];
  const needsReason = role !== user.role && (ENG.includes(role) || ENG.includes(user.role));
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent closeLabel={t('ui.close')} className="max-w-lg" data-testid="user-edit-dialog">
        <DialogTitle className="mb-1 text-lg font-semibold text-heading">{user.name}</DialogTitle>
        <DialogDescription className="mb-4 text-sm text-muted">
          <Ltr>{user.email}</Ltr>
        </DialogDescription>
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1">
            <Label htmlFor="e-role">{t('users.col.role')}</Label>
            <Select value={role} onValueChange={(r) => setRole(r as Role)} disabled={self}>
              <SelectTrigger id="e-role" aria-label={t('users.col.role')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ROLES.map((r) => (
                  <SelectItem key={r} value={r}>
                    {t(`roles.${r}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {self && <p className="text-xs text-muted">{t('users.ownRole')}</p>}
          {needsReason && (
            <div className="flex flex-col gap-1">
              <Label htmlFor="e-reason">{t('users.roleReason')}</Label>
              <Input
                id="e-reason"
                data-testid="role-reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
              <p className="text-xs text-muted">{t('users.roleReasonHint')}</p>
            </div>
          )}
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 text-sm font-medium text-heading">{t('users.plants')}</legend>
            <p className="text-xs text-muted">{t('users.plantsHint')}</p>
            {(plants.data ?? []).map((p) => (
              <label key={p.id} className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={ids.includes(p.id)}
                  onCheckedChange={(c) =>
                    setIds((s) => (c === true ? [...s, p.id] : s.filter((x) => x !== p.id)))
                  }
                  aria-label={lang === 'ar' ? p.nameAr : p.nameEn}
                />
                <Ltr mono className="text-xs">
                  {p.code}
                </Ltr>{' '}
                {lang === 'ar' ? p.nameAr : p.nameEn}
              </label>
            ))}
          </fieldset>
          <div className="flex flex-col gap-1">
            <Label htmlFor="e-pw">{t('users.resetPassword')}</Label>
            <div className="flex gap-2">
              <Input
                id="e-pw"
                type="password"
                dir="ltr"
                autoComplete="new-password"
                value={pw}
                onChange={(e) => setPw(e.target.value)}
              />
              <Button
                variant="secondary"
                disabled={pw.length < 8 || reset.isPending}
                onClick={() => reset.mutate()}
              >
                <KeyRound className="size-4" aria-hidden />
                {t('users.reset')}
              </Button>
            </div>
          </div>
        </div>
        {err && (
          <p role="alert" className="mt-3 text-sm text-fail-text">
            {err}
          </p>
        )}
        <div className="mt-5 flex flex-wrap justify-between gap-2">
          <Button
            variant="danger"
            disabled={self || off.isPending}
            onClick={() => off.mutate()}
            data-testid="user-deactivate"
          >
            <UserMinus className="size-4" aria-hidden />
            {t('users.deactivate')}
          </Button>
          <span className="flex gap-2">
            <Button variant="secondary" onClick={onClose}>
              {t('rules.cancel')}
            </Button>
            <Button
              disabled={save.isPending}
              onClick={() => save.mutate()}
              data-testid="user-edit-save"
            >
              {t('plants.save')}
            </Button>
          </span>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function UsersTab() {
  const { t } = useTranslation();
  const users = useQuery(usersQuery);
  const [edit, setEdit] = useState<AdminUser | null>(null);
  const [creating, setCreating] = useState(false);
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <p className="max-w-2xl text-sm text-muted">{t('users.intro')}</p>
        <Button onClick={() => setCreating(true)} data-testid="new-user">
          <Plus className="size-4" aria-hidden />
          {t('users.new')}
        </Button>
      </div>
      {users.isLoading && <Skeleton className="h-24 w-full" />}
      {users.data && (
        <Table data-testid="users-table">
          <caption className="sr-only">{t('users.title')}</caption>
          <thead>
            <tr>
              <Th>{t('users.col.name')}</Th>
              <Th className="hidden md:table-cell">{t('users.col.email')}</Th>
              <Th>{t('users.col.role')}</Th>
              <Th className="hidden md:table-cell">{t('users.plants')}</Th>
            </tr>
          </thead>
          <tbody>
            {users.data.map((u) => (
              <tr key={u.id} data-testid="user-row">
                <Td>
                  <button
                    type="button"
                    className="text-start font-medium text-heading underline-offset-2 hover:underline"
                    onClick={() => setEdit(u)}
                  >
                    {u.name}
                  </button>
                </Td>
                <Td className="hidden md:table-cell">
                  <Ltr>{u.email}</Ltr>
                </Td>
                <Td>{t(`roles.${u.role}`)}</Td>
                <Td className="hidden md:table-cell">{u.plantIds.length}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      {creating && <NewUserDialog onClose={() => setCreating(false)} />}
      {edit && <UserDialog key={edit.id} user={edit} onClose={() => setEdit(null)} />}
    </div>
  );
}

export function SettingsPage() {
  const { t } = useTranslation();
  const { data: me } = useMe();
  if (me && !me.capabilities.includes('settings.edit')) return <SectionPage id="settings" />;
  const canUsers = me?.capabilities.includes('org.manage') ?? false;
  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="text-2xl font-semibold text-heading">{t('nav.settings')}</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted">{t('settings.intro')}</p>
      </header>
      <Tabs defaultValue="general">
        <TabsList>
          <TabsTrigger value="general">{t('settings.general')}</TabsTrigger>
          {canUsers && <TabsTrigger value="users">{t('users.title')}</TabsTrigger>}
        </TabsList>
        <TabsContent value="general" className="pt-6">
          <GeneralTab />
        </TabsContent>
        {canUsers && (
          <TabsContent value="users" className="pt-6">
            <UsersTab />
          </TabsContent>
        )}
      </Tabs>
    </div>
  );
}
