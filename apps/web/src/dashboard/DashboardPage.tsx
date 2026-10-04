import { EmptyState, Ltr, Skeleton } from '@khalta/ui';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { OctagonAlert, TriangleAlert } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useMe } from '../lib/auth';
import { dashboardQuery, type DashCard } from './api';

const TONE: Record<DashCard['tone'], string> = {
  neutral: 'border-line',
  attention: 'border-warn',
  critical: 'border-fail',
};

function Card({ c }: { c: DashCard }) {
  const { t } = useTranslation();
  const flagged = c.count > 0 && c.tone !== 'neutral';
  const Icon = c.tone === 'critical' ? OctagonAlert : TriangleAlert;
  return (
    <Link
      to={c.to}
      className={`flex min-h-24 flex-col justify-between rounded-lg border bg-surface p-4 outline-offset-2 hover:bg-surface-muted focus-visible:outline focus-visible:outline-2 ${flagged ? TONE[c.tone] : 'border-line'}`}
      data-testid="dash-card"
      data-card={c.id}
      data-count={c.count}
    >
      <span className="text-sm text-muted">{t(`dashboard.card.${c.id}`)}</span>
      <span className="flex items-center gap-2 text-3xl font-semibold tabular-nums text-heading">
        <Ltr>{c.count}</Ltr>
        {flagged && (
          <Icon
            className={`size-5 ${c.tone === 'critical' ? 'text-fail-text' : 'text-warn-text'}`}
            aria-label={t(
              c.tone === 'critical' ? 'dashboard.needsAction' : 'dashboard.needsAttention',
            )}
          />
        )}
      </span>
      <span className="text-xs text-muted">{t(`dashboard.hint.${c.id}`)}</span>
    </Link>
  );
}

/** What this role should look at first. Counts and short worklists only; money lives on the screens that gate it. */
export function DashboardPage() {
  const { t } = useTranslation();
  const { data: me } = useMe();
  const q = useQuery(dashboardQuery);
  if (q.isLoading || !me) return <Skeleton className="h-40 w-full" />;
  if (q.isError || !q.data)
    return <EmptyState title={t('errors.loadFailed')} description={t('dashboard.error')} />;
  const d = q.data;
  return (
    <div className="flex flex-col gap-6" data-testid="dashboard">
      <header>
        <h1 className="text-2xl font-semibold text-heading">{t('nav.dashboard')}</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted">{t(`dashboard.intro.${d.role}`)}</p>
      </header>
      {d.cards.length === 0 ? (
        <EmptyState
          title={t('dashboard.empty.title')}
          description={t('dashboard.empty.description')}
        />
      ) : (
        <section
          aria-label={t('dashboard.cards')}
          className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4"
        >
          {d.cards.map((c) => (
            <Card key={c.id} c={c} />
          ))}
        </section>
      )}
      {d.worklists.awaitingApproval.length > 0 && (
        <section aria-label={t('dashboard.card.awaitingApproval')} data-testid="work-approval">
          <h2 className="mb-2 text-lg font-semibold text-heading">
            {t('dashboard.card.awaitingApproval')}
          </h2>
          <ul className="flex flex-col gap-1 text-sm">
            {d.worklists.awaitingApproval.map((x) => (
              <li key={x.id}>
                <Link to="/library" className="text-primary underline">
                  <Ltr mono>{x.code}</Ltr>
                </Link>{' '}
                {x.name}
              </li>
            ))}
          </ul>
        </section>
      )}
      {d.worklists.alerts.length > 0 && (
        <section aria-label={t('dashboard.alerts')} data-testid="work-alerts">
          <h2 className="mb-2 text-lg font-semibold text-heading">{t('dashboard.alerts')}</h2>
          <ul className="flex flex-col gap-1 text-sm">
            {d.worklists.alerts.map((a) => (
              <li key={a.id} className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{t(`insights.severity.${a.severity}`)}</span>
                <Link to="/insights" className="text-primary underline">
                  {t(`insights.type.${a.type}`)}
                </Link>
                {a.designCode && <Ltr mono>{a.designCode}</Ltr>}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
