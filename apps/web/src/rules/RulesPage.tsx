import {
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@khalta/ui';
import { useQuery } from '@tanstack/react-query';
import { ShieldAlert } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMe } from '../lib/auth';
import { rulesQuery, type Rule } from './api';
import { SectionPage } from '../pages/Section';
import { ImportPanel } from './ImportPanel';
import { RuleSheet } from './RuleSheet';
import { RulesTable } from './RulesTable';

const ALL = 'all';

export function RulesPage() {
  const { t } = useTranslation();
  const { data: me } = useMe();
  const canRead = (me?.capabilities ?? []).includes('rules.read');
  const { data, isLoading, isError } = useQuery({ ...rulesQuery, enabled: canRead });
  // Each edit creates a new rule row (new id), so the open rule is tracked by ruleset + key.
  const [openRef, setOpenRef] = useState<string | null>(null);
  const [ruleset, setRuleset] = useState(ALL);
  const [status, setStatus] = useState(ALL);
  const [cls, setCls] = useState(ALL);
  const [q, setQ] = useState('');
  const caps = me?.capabilities ?? [];
  const canVerify = caps.includes('rules.verify');
  const canImport = caps.includes('import.run');

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (data?.rules ?? []).filter(
      (r) =>
        (ruleset === ALL || r.ruleset === ruleset) &&
        (status === ALL || r.status === status) &&
        (cls === ALL || r.requirementClass === cls) &&
        (!needle ||
          [r.key, r.clauseRef, r.noteEn ?? '', r.noteAr ?? ''].some((s) =>
            s.toLowerCase().includes(needle),
          )),
    );
  }, [data, ruleset, status, cls, q]);

  const open = data?.rules.find((r) => `${r.ruleset}:${r.key}` === openRef) ?? null;
  const code = filtered.filter((r) => r.ruleset !== 'ENGINEERING');
  const engineering = filtered.filter((r) => r.ruleset === 'ENGINEERING');

  const counted = Object.entries(data?.summary.byRuleset ?? {}).filter(
    ([k]) => k !== 'ENGINEERING',
  );
  const unverified = counted.reduce((n, [, s]) => n + s.unverified, 0);
  const missing = counted.reduce((n, [, s]) => n + s.missing, 0);
  const verified = counted.reduce((n, [, s]) => n + s.verified, 0);

  const classes = [...new Set((data?.rules ?? []).map((r) => r.requirementClass))].sort();
  const rulesets = Object.keys(data?.summary.byRuleset ?? {}).filter((r) => r !== 'ENGINEERING');

  // A role without rules.read gets the standard "not available for your role" explanation.
  if (me && !canRead) return <SectionPage id="rules" />;

  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="text-2xl font-semibold text-heading">{t('nav.rules')}</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted">{t('rules.intro')}</p>
      </header>

      {data && unverified + missing > 0 && (
        <div
          role="status"
          className="flex items-start gap-3 rounded-lg border border-warn bg-warn-bg p-4 text-sm text-warn-text"
          data-testid="rules-banner"
        >
          <ShieldAlert className="mt-0.5 size-5 shrink-0" aria-hidden />
          <div>
            <p className="font-medium">
              {t('rules.banner.title', { unverified, missing, verified })}
            </p>
            <p>{t('rules.banner.body')}</p>
          </div>
        </div>
      )}

      <Tabs defaultValue="rules">
        <TabsList>
          <TabsTrigger value="rules">{t('rules.tabs.rules')}</TabsTrigger>
          <TabsTrigger value="engineering">{t('rules.tabs.engineering')}</TabsTrigger>
          {canImport && <TabsTrigger value="import">{t('rules.tabs.import')}</TabsTrigger>}
        </TabsList>

        <div
          className="flex flex-wrap items-end gap-3 py-4"
          role="search"
          aria-label={t('rules.filters')}
        >
          <div className="w-64 max-w-full">
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={t('rules.search')}
              aria-label={t('rules.search')}
              data-testid="rules-search"
            />
          </div>
          <Select value={ruleset} onValueChange={setRuleset}>
            <SelectTrigger aria-label={t('rules.filter.ruleset')} className="w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>{t('rules.filter.allRulesets')}</SelectItem>
              {rulesets.map((r) => (
                <SelectItem key={r} value={r}>
                  {t(`rules.rulesets.${r}`, { defaultValue: r })}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={cls} onValueChange={setCls}>
            <SelectTrigger aria-label={t('rules.col.class')} className="w-52">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>{t('rules.filter.allClasses')}</SelectItem>
              {classes.map((c) => (
                <SelectItem key={c} value={c}>
                  {t(`rules.class.${c}`, { defaultValue: c })}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={status} onValueChange={setStatus}>
            <SelectTrigger aria-label={t('rules.col.status')} className="w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>{t('rules.filter.allStatuses')}</SelectItem>
              {['verified', 'unverified', 'missing', 'info'].map((s) => (
                <SelectItem key={s} value={s}>
                  {t(`ui.verification.${s}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {isLoading && (
          <div className="flex flex-col gap-2">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        )}
        {isError && (
          <p role="alert" className="text-sm text-fail-text">
            {t('errors.loadFailed')}
          </p>
        )}
        {data && (
          <>
            <TabsContent value="rules">
              <RulesTable rules={code} onOpen={(r: Rule) => setOpenRef(`${r.ruleset}:${r.key}`)} />
            </TabsContent>
            <TabsContent value="engineering">
              <p className="mb-4 max-w-3xl text-sm text-muted">{t('rules.engineeringIntro')}</p>
              <RulesTable
                rules={engineering}
                onOpen={(r: Rule) => setOpenRef(`${r.ruleset}:${r.key}`)}
              />
            </TabsContent>
          </>
        )}
        {canImport && (
          <TabsContent value="import">
            <ImportPanel />
          </TabsContent>
        )}
      </Tabs>

      <RuleSheet
        rule={open}
        onClose={() => setOpenRef(null)}
        canVerify={canVerify}
        canEdit={canImport}
      />
    </div>
  );
}
