import { Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { AlertOctagon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { insightsQuery } from '../insights/api';
import { useMe } from '../lib/auth';

/** Critical insights (a failed strength result, a failed compliance check) reach QC managers here; no email or push. */
export function CriticalBanner() {
  const { t } = useTranslation();
  const { data: me } = useMe();
  const allowed = !!me?.capabilities.includes('design.approve');
  const q = useQuery({ ...insightsQuery('critical'), enabled: allowed });
  const n = q.data?.length ?? 0;
  if (!allowed || n === 0) return null;
  return (
    <div
      role="alert"
      data-testid="critical-banner"
      className="flex items-center justify-center gap-2 bg-fail-bg px-4 py-1.5 text-center text-sm font-medium text-fail-text"
    >
      <AlertOctagon className="size-4 shrink-0" aria-hidden />
      <span>{t('insights.banner', { n })}</span>
      <Link to="/insights" className="underline" data-testid="critical-banner-link">
        {t('insights.bannerLink')}
      </Link>
    </div>
  );
}
