import type { Source } from '@khalta/engine';
import { EvidenceChip, cn } from '@khalta/ui';
import { CircleCheck, Clock, FileBadge, Hourglass, TriangleAlert } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { Freshness } from './api';

const chip =
  'inline-flex items-center gap-1.5 whitespace-nowrap rounded-md border px-2 py-0.5 text-xs font-medium';

/** Where a value came from. Declared values reuse the shared evidence chip so they read the same everywhere. */
export function SourceChip({ source, className }: { source: Source; className?: string }) {
  const { t } = useTranslation();
  if (source === 'user_declared')
    return <EvidenceChip status="INPUT_USER_DECLARED" className={className} />;
  const lab = source === 'lab_report';
  return (
    <span
      data-source-kind={source}
      className={cn(
        chip,
        lab
          ? 'border-pass bg-pass-bg text-pass-text'
          : 'border-olive bg-olive-tint text-olive-text',
        className,
      )}
    >
      {lab ? (
        <CircleCheck className="size-3.5" aria-hidden />
      ) : (
        <FileBadge className="size-3.5" aria-hidden />
      )}
      {t(`materials.source.${source}`)}
    </span>
  );
}

/** Test age against the QC limit. No limit configured is stated as such, never shown as "fresh". */
export function FreshnessChip({
  freshness,
  className,
}: {
  freshness: Freshness;
  className?: string;
}) {
  const { t } = useTranslation();
  if (freshness.status === 'not_configured')
    return (
      <span
        data-freshness="not_configured"
        className={cn(chip, 'border-line bg-transparent text-muted', className)}
      >
        <Clock className="size-3.5" aria-hidden />
        {t('materials.freshness.not_configured')}
      </span>
    );
  const expired = freshness.status === 'expired';
  return (
    <span
      data-freshness={freshness.status}
      className={cn(
        chip,
        expired ? 'border-warn bg-warn-bg text-warn-text' : 'border-pass bg-pass-bg text-pass-text',
        className,
      )}
    >
      {expired ? (
        <Hourglass className="size-3.5" aria-hidden />
      ) : (
        <CircleCheck className="size-3.5" aria-hidden />
      )}
      {t(`materials.freshness.${freshness.status}`)}
    </span>
  );
}

export function ReadyChip({
  kind,
  ok,
  className,
}: {
  kind: 'evaluate' | 'design';
  ok: boolean;
  className?: string;
}) {
  const { t } = useTranslation();
  return (
    <span
      data-ready={`${kind}:${ok}`}
      className={cn(
        chip,
        ok ? 'border-pass bg-pass-bg text-pass-text' : 'border-line bg-transparent text-muted',
        className,
      )}
    >
      {ok ? (
        <CircleCheck className="size-3.5" aria-hidden />
      ) : (
        <TriangleAlert className="size-3.5" aria-hidden />
      )}
      {t(ok ? `materials.ready.${kind}` : `materials.notReady.${kind}`)}
    </span>
  );
}
