import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  EmptyState,
  Label,
  Ltr,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  Textarea,
  toast,
} from '@khalta/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { AlertOctagon, AlertTriangle, Info, Wand2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../lib/api';
import { useMe } from '../lib/auth';
import { useFormat } from '../lib/format';
import { usePlant } from '../lib/plant';
import { usePrefs } from '../lib/prefs';
import {
  acceptInsight,
  digestQuery,
  dismissInsight,
  insightsQuery,
  snoozeInsight,
  type Insight,
  type Severity,
} from './api';

const ALL = 'all';
const TYPES = [
  'opportunity',
  'test_expired',
  'prices_stale',
  'test_drift',
  'rule_change',
  'low_strength',
  'compliance_failure',
  'model_invalidated',
];
const SEV_STYLE: Record<Severity, { icon: typeof Info; cls: string }> = {
  critical: { icon: AlertOctagon, cls: 'border-fail bg-fail-bg text-fail-text' },
  high: { icon: AlertTriangle, cls: 'border-warn bg-warn-bg text-warn-text' },
  medium: { icon: AlertTriangle, cls: 'border-line bg-transparent text-body' },
  info: { icon: Info, cls: 'border-line bg-transparent text-muted' },
};

export function SeverityChip({ severity }: { severity: Severity }) {
  const { t } = useTranslation();
  const { icon: Icon, cls } = SEV_STYLE[severity];
  return (
    <span
      data-severity={severity}
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium ${cls}`}
    >
      <Icon className="size-3.5" aria-hidden />
      {t(`insights.severity.${severity}`)}
    </span>
  );
}

/** One plain line per insight type; every number comes from the stored payload, none is computed here. */
function useSummary() {
  const { t } = useTranslation();
  return (i: Insight): string => {
    const p = i.payload as Record<string, unknown>;
    const len = (v: unknown) => (Array.isArray(v) ? v.length : 0);
    const code = String(p['designCode'] ?? '');
    switch (i.type) {
      case 'opportunity':
        return t('insights.summary.opportunity', { code });
      case 'low_strength':
        if (p['criterion'] === 'acceptance')
          return t('insights.summary.low_acceptance', { code, n: len(p['breaches']) });
        if (p['criterion'] === 'sequence')
          return t('insights.summary.low_sequence', { code, n: Number(p['sets'] ?? 0) });
        return t('insights.summary.low_strength', {
          code,
          avg: String(p['averageMpa'] ?? ''),
          req: String(p['requiredFcrMpa'] ?? ''),
        });
      case 'compliance_failure':
        return t('insights.summary.compliance_failure', {
          code,
          n: len(p['failingChecks']),
        });
      case 'test_drift':
        return t('insights.summary.test_drift', {
          name: String(p['materialName'] ?? ''),
          n: len(p['drift']),
          designs: Number(p['affectedDesigns'] ?? 0),
        });
      case 'rule_change':
        return t('insights.summary.rule_change', { n: len(p['newFailures']) });
      case 'test_expired':
        return t('insights.summary.test_expired', { n: len(p['expired']) });
      case 'model_invalidated':
        return t('insights.summary.model_invalidated', { n: len(p['reasons']) });
      case 'prices_stale':
        return t('insights.summary.prices_stale', { n: len(p['stale']) });
    }
  };
}

function DismissDialog({ insight, onClose }: { insight: Insight; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [reason, setReason] = useState('');
  const m = useMutation({
    mutationFn: () => dismissInsight(insight.id, reason.trim()),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['insights'] });
      toast.success(t('insights.dismissed'));
      onClose();
    },
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent closeLabel={t('ui.close')} className="max-w-md" data-testid="dismiss-dialog">
        <DialogTitle className="mb-1 text-lg font-semibold text-heading">
          {t('insights.dismiss')}
        </DialogTitle>
        <DialogDescription className="mb-3 text-sm text-muted">
          {t('insights.dismissHint')}
        </DialogDescription>
        <Label htmlFor="dismiss-reason">{t('insights.reason')}</Label>
        <Textarea
          id="dismiss-reason"
          data-testid="dismiss-reason"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
        {m.error instanceof ApiError && (
          <p role="alert" className="mt-2 text-sm text-fail-text">
            {m.error.message}
          </p>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            {t('rules.cancel')}
          </Button>
          <Button
            disabled={reason.trim().length < 3 || m.isPending}
            onClick={() => m.mutate()}
            data-testid="dismiss-submit"
          >
            {t('insights.dismiss')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Card({ insight }: { insight: Insight }) {
  const { t } = useTranslation();
  const f = useFormat();
  const { lang } = usePrefs();
  const { plants } = usePlant();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { data: me } = useMe();
  const caps = me?.capabilities ?? [];
  const summary = useSummary();
  const [dismiss, setDismiss] = useState(false);
  const plant = plants.find((p) => p.id === insight.plantId);
  const refresh = () => qc.invalidateQueries({ queryKey: ['insights'] });
  const snooze = useMutation({
    mutationFn: (days: 1 | 7) => snoozeInsight(insight.id, days),
    onSuccess: async () => {
      await refresh();
      toast.success(t('insights.snoozed'));
    },
  });
  const accept = useMutation({
    mutationFn: () => acceptInsight(insight.id),
    onSuccess: async (r) => {
      await refresh();
      await qc.invalidateQueries({ queryKey: ['designs'] });
      await qc.invalidateQueries({ queryKey: ['savings'] });
      toast.success(t('insights.accepted'));
      void navigate({ to: '/library', search: { design: r.design.id } as never });
    },
  });
  const err =
    (snooze.error ?? accept.error) instanceof ApiError ? (snooze.error ?? accept.error) : null;
  const canTriage = caps.includes('insight.draft');
  const canAccept = caps.includes('insight.accept') && insight.type === 'opportunity';
  return (
    <li
      className="rounded-lg border border-line bg-surface p-4"
      data-testid="insight-card"
      data-type={insight.type}
      data-severity={insight.severity}
    >
      <div className="flex flex-wrap items-center gap-2">
        <SeverityChip severity={insight.severity} />
        <h3 className="text-base font-semibold text-heading">
          {t(`insights.type.${insight.type}`)}
        </h3>
        {insight.status === 'snoozed' && (
          <span className="text-xs text-muted">{t('insights.snoozedBack')}</span>
        )}
      </div>
      <p className="mt-1 text-sm" data-testid="insight-summary">
        {summary(insight)}
      </p>
      <p className="mt-1 text-xs text-muted">
        {plant ? (lang === 'ar' ? plant.nameAr : plant.nameEn) : t('insights.allPlants')} ·{' '}
        <Ltr>{f.dateTime(insight.lastSeenAt)}</Ltr>
      </p>
      {insight.type === 'opportunity' && insight.savingJodPerM3 !== null && (
        <div
          className="mt-3 rounded-md border border-dashed border-muted p-3"
          data-testid="insight-saving"
        >
          <span className="inline-flex items-center gap-1 text-xs font-medium text-muted">
            <Wand2 className="size-3.5" aria-hidden />
            {t('ui.saving.theoretical')}
          </span>
          <p className="text-sm">
            <Ltr>
              {t('evaluation.unit.jodm3', {
                n: f.number(Number(insight.savingJodPerM3), { maximumFractionDigits: 3 }),
              })}
            </Ltr>
            {insight.annualJod && (
              <>
                {' · '}
                <Ltr>
                  {t('savings.jodYear', {
                    n: f.number(Number(insight.annualJod), { maximumFractionDigits: 0 }),
                  })}
                </Ltr>
                <span className="ms-1 text-xs text-muted">{t('savings.estimate')}</span>
              </>
            )}
          </p>
          <p className="text-xs text-muted">{t('insights.opportunityBasis')}</p>
          {insight.provisional && (
            <p className="text-xs text-warn-text">{t('evaluation.provisional')}</p>
          )}
        </div>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        {insight.designId && (
          <Button
            variant="secondary"
            onClick={() =>
              void navigate({ to: '/library', search: { design: insight.designId } as never })
            }
            data-testid="insight-open-design"
          >
            {t('insights.openDesign')}
          </Button>
        )}
        {canAccept && (
          <Button
            onClick={() => accept.mutate()}
            disabled={accept.isPending}
            data-testid="insight-accept"
          >
            {t('insights.accept')}
          </Button>
        )}
        {canTriage && (
          <>
            <Button
              variant="secondary"
              onClick={() => snooze.mutate(1)}
              disabled={snooze.isPending}
              data-testid="insight-snooze-1"
            >
              {t('insights.snooze1')}
            </Button>
            <Button
              variant="secondary"
              onClick={() => snooze.mutate(7)}
              disabled={snooze.isPending}
              data-testid="insight-snooze-7"
            >
              {t('insights.snooze7')}
            </Button>
            <Button variant="ghost" onClick={() => setDismiss(true)} data-testid="insight-dismiss">
              {t('insights.dismiss')}
            </Button>
          </>
        )}
      </div>
      {canAccept && <p className="mt-2 text-xs text-muted">{t('insights.acceptHint')}</p>}
      {err && (
        <p role="alert" className="mt-2 text-sm text-fail-text" data-testid="insight-error">
          {err.message}
        </p>
      )}
      {dismiss && <DismissDialog insight={insight} onClose={() => setDismiss(false)} />}
    </li>
  );
}

export function InsightsPage() {
  const { t } = useTranslation();
  const f = useFormat();
  const [severity, setSeverity] = useState<string>(ALL);
  const [type, setType] = useState<string>(ALL);
  const list = useQuery(insightsQuery(severity === ALL ? undefined : (severity as Severity)));
  const digest = useQuery(digestQuery);
  const rows = (list.data ?? []).filter((i) => type === ALL || i.type === type);
  const d = digest.data?.summary;
  return (
    <div className="flex flex-col gap-6" data-testid="insights-page">
      <header>
        <h1 className="text-2xl font-semibold text-heading">{t('nav.insights')}</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted">{t('insights.intro')}</p>
      </header>

      <section aria-label={t('insights.digest.title')} data-testid="digest-panel">
        <h2 className="mb-2 text-lg font-semibold text-heading">{t('insights.digest.title')}</h2>
        {digest.data === null && <p className="text-sm text-muted">{t('insights.digest.none')}</p>}
        {digest.data && d && (
          <p className="text-sm">
            <Ltr>{digest.data.day}</Ltr>
            {' · '}
            {t('insights.digest.line', {
              open: f.number(d.open),
              fresh: f.number(d.new24h),
              critical: f.number(d.bySeverity['critical'] ?? 0),
              high: f.number(d.bySeverity['high'] ?? 0),
            })}
          </p>
        )}
      </section>

      <section aria-label={t('insights.inbox')} className="flex flex-col gap-3">
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-1">
            <Label htmlFor="ins-sev">{t('insights.filter.severity')}</Label>
            <Select value={severity} onValueChange={setSeverity}>
              <SelectTrigger id="ins-sev" className="w-44" data-testid="filter-severity">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>{t('insights.filter.all')}</SelectItem>
                {(['critical', 'high', 'medium', 'info'] as const).map((s) => (
                  <SelectItem key={s} value={s}>
                    {t(`insights.severity.${s}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="ins-type">{t('insights.filter.type')}</Label>
            <Select value={type} onValueChange={setType}>
              <SelectTrigger id="ins-type" className="w-56" data-testid="filter-type">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>{t('insights.filter.all')}</SelectItem>
                {TYPES.map((x) => (
                  <SelectItem key={x} value={x}>
                    {t(`insights.type.${x}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        {list.isLoading && <Skeleton className="h-24 w-full" />}
        {list.data && rows.length === 0 && (
          <EmptyState
            title={t('insights.empty.title')}
            description={t('insights.empty.description')}
          />
        )}
        <ul className="flex flex-col gap-3" data-testid="insight-list">
          {rows.map((i) => (
            <Card key={i.id} insight={i} />
          ))}
        </ul>
      </section>
    </div>
  );
}
