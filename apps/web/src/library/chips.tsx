import { cn } from '@khalta/ui';
import { BadgeCheck, CircleDashed, FileClock, Hourglass, PackageCheck } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { DesignCard } from './api';

const chip =
  'inline-flex items-center gap-1.5 whitespace-nowrap rounded-md border px-2 py-0.5 text-xs font-medium';

/** Lifecycle state: icon + text + colour. */
export function DesignStatusChip({ status }: { status: DesignCard['status'] }) {
  const { t } = useTranslation();
  const live = status === 'approved' || status === 'in_production';
  const Icon =
    status === 'in_production'
      ? PackageCheck
      : live
        ? BadgeCheck
        : status === 'draft'
          ? CircleDashed
          : FileClock;
  return (
    <span
      data-status={status}
      className={cn(
        chip,
        live ? 'border-pass bg-pass-bg text-pass-text' : 'border-line bg-transparent text-muted',
      )}
    >
      <Icon className="size-3.5" aria-hidden />
      {t(`library.status.${status}`)}
    </span>
  );
}

/** Where an approval came from; legacy attestation is explicitly "not evaluated by Khalta". */
export function ApprovalChip({
  design,
}: {
  design: Pick<DesignCard, 'approvalSource' | 'evaluationPending'>;
}) {
  const { t } = useTranslation();
  if (design.approvalSource !== 'legacy_attested') return null;
  return (
    <span
      data-approval="legacy_attested"
      className={cn(chip, 'border-warn bg-warn-bg text-warn-text')}
    >
      <Hourglass className="size-3.5" aria-hidden />
      {design.evaluationPending ? t('library.legacyNotEvaluated') : t('library.legacyAttested')}
    </span>
  );
}
