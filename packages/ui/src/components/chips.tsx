import {
  BadgeCheck,
  CircleCheck,
  CircleHelp,
  CircleX,
  FlaskConical,
  Hourglass,
  Info,
  ShieldAlert,
  ShieldCheck,
  TrendingDown,
  TriangleAlert,
  Wand2,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '../cn';
import { Ltr } from './bidi';

const chip =
  'inline-flex items-center gap-1.5 whitespace-nowrap rounded-md border px-2 py-0.5 text-xs font-medium';

/* ---- Pass / warn / fail: always icon + text + colour ---- */
export const STATUSES = ['pass', 'warn', 'fail'] as const;
export type Status = (typeof STATUSES)[number];
const STATUS_STYLE: Record<Status, { icon: LucideIcon; cls: string }> = {
  pass: { icon: CircleCheck, cls: 'border-pass bg-pass-bg text-pass-text' },
  warn: { icon: TriangleAlert, cls: 'border-warn bg-warn-bg text-warn-text' },
  fail: { icon: CircleX, cls: 'border-fail bg-fail-bg text-fail-text' },
};

export function StatusChip({ status, className }: { status: Status; className?: string }) {
  const { t } = useTranslation();
  const { icon: Icon, cls } = STATUS_STYLE[status];
  return (
    <span data-status={status} className={cn(chip, cls, className)}>
      <Icon className="size-3.5" aria-hidden />
      {t(`ui.status.${status}`)}
    </span>
  );
}

/* ---- Source badges: ACI = grey outline, JS = green fill, PROJECT = olive fill ---- */
export const CODE_SOURCES = ['ACI', 'JS', 'PROJECT'] as const;
export type CodeSource = (typeof CODE_SOURCES)[number];
const CODE_STYLE: Record<CodeSource, string> = {
  ACI: 'border-heading text-heading bg-transparent',
  JS: 'border-primary bg-primary text-on-primary',
  PROJECT: 'border-olive bg-olive text-on-olive',
};

export function CodeBadge({ source, className }: { source: CodeSource; className?: string }) {
  const { t } = useTranslation();
  return (
    <span data-source={source} className={cn(chip, CODE_STYLE[source], className)}>
      {source === 'PROJECT' ? t('ui.code.PROJECT') : <Ltr>{source}</Ltr>}
    </span>
  );
}

/* ---- Evidence statuses (CLAUDE.md): a closed set, label only. Never a score or percentage. ---- */
export const EVIDENCE_STATUSES = [
  'CODE_VERIFIED',
  'PROJECT_VERIFIED',
  'RULE_UNVERIFIED',
  'MODEL_IN_DOMAIN',
  'MODEL_BASELINE',
  'MODEL_EXTRAPOLATED',
  'INPUT_STALE',
  'INPUT_MISSING',
  'TRIAL_REQUIRED',
] as const;
export type EvidenceStatus = (typeof EVIDENCE_STATUSES)[number];

const EVIDENCE_STYLE: Record<EvidenceStatus, { icon: LucideIcon; cls: string }> = {
  CODE_VERIFIED: { icon: ShieldCheck, cls: STATUS_STYLE.pass.cls },
  PROJECT_VERIFIED: { icon: BadgeCheck, cls: STATUS_STYLE.pass.cls },
  MODEL_IN_DOMAIN: { icon: CircleCheck, cls: STATUS_STYLE.pass.cls },
  RULE_UNVERIFIED: { icon: ShieldAlert, cls: STATUS_STYLE.warn.cls },
  MODEL_EXTRAPOLATED: { icon: TriangleAlert, cls: STATUS_STYLE.warn.cls },
  INPUT_STALE: { icon: Hourglass, cls: STATUS_STYLE.warn.cls },
  TRIAL_REQUIRED: { icon: FlaskConical, cls: STATUS_STYLE.warn.cls },
  MODEL_BASELINE: { icon: Info, cls: 'border-olive bg-olive-tint text-olive-text' },
  INPUT_MISSING: { icon: CircleHelp, cls: STATUS_STYLE.fail.cls },
};

export function EvidenceChip({
  status,
  className,
}: {
  status: EvidenceStatus;
  className?: string;
}) {
  const { t } = useTranslation();
  const { icon: Icon, cls } = EVIDENCE_STYLE[status];
  return (
    <span data-evidence={status} className={cn(chip, cls, className)}>
      <Icon className="size-3.5" aria-hidden />
      {t(`ui.evidence.${status}`)}
    </span>
  );
}

/* ---- Savings are never summed across states; every figure carries its state label ---- */
export const SAVING_STATES = ['theoretical', 'approved', 'realized'] as const;
export type SavingState = (typeof SAVING_STATES)[number];
const SAVING_ICON: Record<SavingState, LucideIcon> = {
  theoretical: Wand2,
  approved: BadgeCheck,
  realized: TrendingDown,
};
const SAVING_CLS: Record<SavingState, string> = {
  theoretical: 'border-dashed border-muted text-muted bg-transparent',
  approved: 'border-olive bg-olive-tint text-olive-text',
  realized: 'border-pass bg-pass-bg text-pass-text',
};

export function SavingStateLabel({ state, className }: { state: SavingState; className?: string }) {
  const { t } = useTranslation();
  const Icon = SAVING_ICON[state];
  return (
    <span data-saving-state={state} className={cn(chip, SAVING_CLS[state], className)}>
      <Icon className="size-3.5" aria-hidden />
      {t(`ui.saving.${state}`)}
    </span>
  );
}

/* ---- Rule verification state: icon + text + colour ---- */
export const VERIFICATION_STATES = ['verified', 'unverified', 'missing', 'info'] as const;
export type VerificationState = (typeof VERIFICATION_STATES)[number];
const VERIFICATION_STYLE: Record<VerificationState, { icon: LucideIcon; cls: string }> = {
  verified: { icon: ShieldCheck, cls: STATUS_STYLE.pass.cls },
  unverified: { icon: ShieldAlert, cls: STATUS_STYLE.warn.cls },
  missing: { icon: CircleHelp, cls: STATUS_STYLE.fail.cls },
  info: { icon: Info, cls: 'border-line bg-transparent text-muted' },
};

export function VerificationChip({
  state,
  className,
}: {
  state: VerificationState;
  className?: string;
}) {
  const { t } = useTranslation();
  const { icon: Icon, cls } = VERIFICATION_STYLE[state];
  return (
    <span data-verification={state} className={cn(chip, cls, className)}>
      <Icon className="size-3.5" aria-hidden />
      {t(`ui.verification.${state}`)}
    </span>
  );
}
