import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  Label,
  Textarea,
  toast,
} from '@khalta/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Capability } from '@khalta/rbac';
import { Check, CircleAlert } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../lib/api';
import { useMe } from '../lib/auth';
import type { DesignCard } from './api';
import {
  acceptAssumptions,
  acceptDeclared,
  gatesQuery,
  runAction,
  startTrial,
  type Action,
  type Gate,
  type Target,
} from './lifecycleApi';

const TARGET: Partial<Record<Action, Target>> = {
  'start-trial': 'trial_in_progress',
  'pass-trial': 'trial_passed',
  approve: 'approved',
};
const CAP: Record<Action, Capability> = {
  'start-trial': 'trial.request',
  'pass-trial': 'trial.pass',
  approve: 'design.approve',
  release: 'production.release',
  retire: 'design.approve',
  suspend: 'design.approve',
  reinstate: 'design.approve',
};

/** The next steps this design can take, per status (the server's graph still decides). */
function actionsFor(status: string): Action[] {
  switch (status) {
    case 'trial_candidate':
      return ['start-trial', 'retire'];
    case 'trial_in_progress':
      return ['pass-trial', 'retire'];
    case 'trial_passed':
      return ['approve', 'retire'];
    case 'approved':
      return ['release', 'suspend', 'retire'];
    case 'in_production':
      return ['suspend', 'retire'];
    case 'suspended':
      return ['reinstate', 'retire'];
    case 'draft':
    case 'evaluated':
      return ['retire'];
    default:
      return [];
  }
}

export function GateList({ gates }: { gates: Gate[] }) {
  const { t } = useTranslation();
  return (
    <ul className="flex flex-col gap-1 text-sm" data-testid="gate-list">
      {gates.map((g) => (
        <li
          key={g.id}
          className="flex items-start gap-2"
          data-testid={`gate-${g.id}`}
          data-met={g.met}
        >
          {g.met ? (
            <Check className="mt-0.5 size-4 shrink-0 text-pass-text" aria-hidden />
          ) : (
            <CircleAlert className="mt-0.5 size-4 shrink-0 text-fail-text" aria-hidden />
          )}
          <span>
            {t(`lifecycle.gate.${g.id}`, { defaultValue: g.id })}
            <span className={`block text-xs ${g.met ? 'text-muted' : 'text-fail-text'}`}>
              {t(`lifecycle.code.${g.code}`, { defaultValue: g.code })}
              {g.detail && g.detail.length > 0 ? ` · ${g.detail.join(', ')}` : ''}
            </span>
          </span>
        </li>
      ))}
    </ul>
  );
}

/** A typed e-signature: the signer is the signed-in user; the reason and what it means are shown first. */
function SignDialog({
  design,
  action,
  onClose,
}: {
  design: DesignCard;
  action: Action | 'accept' | 'acceptAssumptions';
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [reason, setReason] = useState('');
  // one key per opened dialog: pressing the button twice, or retrying after a lost response, acts once
  const [guard] = useState(() => ({
    idempotencyKey: crypto.randomUUID(),
    expectedStatus: design.status,
  }));
  const m = useMutation({
    mutationFn: () =>
      action === 'accept'
        ? acceptDeclared(design.id, reason.trim())
        : action === 'acceptAssumptions'
          ? acceptAssumptions(design.id, reason.trim())
          : runAction(design.id, action, reason.trim(), guard),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['designs'] });
      toast.success(t('lifecycle.done'));
      onClose();
    },
  });
  const unmet =
    m.error instanceof ApiError && m.error.code === 'gates_unmet'
      ? ((m.error.details as { gates?: Gate[] })?.gates ?? []).filter((g) => !g.met)
      : [];
  const err = m.error instanceof ApiError ? m.error.message : null;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent closeLabel={t('ui.close')} className="max-w-xl" data-testid="sign-dialog">
        <DialogTitle className="mb-1 text-lg font-semibold text-heading">
          {t(`lifecycle.sign.title.${action}`, { code: design.code })}
        </DialogTitle>
        <DialogDescription className="mb-4 text-sm text-muted">
          {t(`lifecycle.sign.meaning.${action}`)}
        </DialogDescription>
        <div className="flex flex-col gap-1">
          <Label htmlFor="sign-reason">{t('lifecycle.sign.reason')}</Label>
          <Textarea
            id="sign-reason"
            data-testid="sign-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </div>
        <p className="mt-3 rounded-md bg-olive-tint p-3 text-sm text-olive-text">
          {t('lifecycle.sign.scope')}
        </p>
        {err && (
          <div role="alert" className="mt-3 text-sm text-fail-text" data-testid="sign-error">
            {err}
            {unmet.length > 0 && <GateList gates={unmet} />}
          </div>
        )}
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            {t('rules.cancel')}
          </Button>
          <Button
            disabled={reason.trim().length < 5 || m.isPending}
            onClick={() => m.mutate()}
            data-testid="sign-submit"
          >
            {t('lifecycle.sign.submit')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Step({ design, action }: { design: DesignCard; action: Action }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const target = TARGET[action];
  const gates = useQuery({ ...gatesQuery(design.id, target ?? 'approved'), enabled: !!target });
  const [signing, setSigning] = useState<Action | 'accept' | 'acceptAssumptions' | null>(null);
  const start = useMutation({
    mutationFn: () => startTrial(design.id),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['designs'] });
      toast.success(t('lifecycle.done'));
    },
  });
  const report = target ? gates.data : undefined;
  const ready = target ? !!report?.ok : true;
  const declaredUnmet = report?.gates.find((g) => g.id === 'declared_values' && !g.met);
  const assumptionsUnmet = report?.gates.find((g) => g.id === 'assumptions_accepted' && !g.met);
  const edgeRefusal = report && !report.edge.ok ? report.edge.reason : null;
  const { data: me } = useMe();
  const caps = me?.capabilities ?? [];
  return (
    <div className="rounded-md border border-line p-3" data-testid={`step-${action}`}>
      <h4 className="mb-2 text-sm font-semibold text-heading">{t(`lifecycle.step.${action}`)}</h4>
      {(action === 'start-trial' || action === 'pass-trial') && (
        <p className="mb-2 text-xs text-muted">{t('lifecycle.trialBatchesLater')}</p>
      )}
      {target && report && <GateList gates={report.gates} />}
      {edgeRefusal && <p className="mt-2 text-xs text-muted">{edgeRefusal}</p>}
      {report?.permitted && !report.permitted.ok && (
        <ul className="mt-2 text-xs text-muted" data-testid="not-permitted">
          {report.permitted.reasons.map((r) => (
            <li key={r}>{t(`lifecycle.permitted.${r}`)}</li>
          ))}
        </ul>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        <Button
          disabled={!ready || !!edgeRefusal || start.isPending || !caps.includes(CAP[action])}
          onClick={() => (action === 'start-trial' ? start.mutate() : setSigning(action))}
          data-testid={`do-${action}`}
          variant={action === 'retire' ? 'secondary' : 'primary'}
        >
          {t(`lifecycle.do.${action}`)}
        </Button>
        {action === 'approve' && assumptionsUnmet && caps.includes('design.approve') && (
          <Button
            variant="secondary"
            onClick={() => setSigning('acceptAssumptions')}
            data-testid="accept-assumptions"
          >
            {t('lifecycle.do.acceptAssumptions')}
          </Button>
        )}
        {action === 'approve' && declaredUnmet && caps.includes('design.approve') && (
          <Button
            variant="secondary"
            onClick={() => setSigning('accept')}
            data-testid="accept-declared"
          >
            {t('lifecycle.do.accept')}
          </Button>
        )}
      </div>
      {start.error instanceof ApiError && (
        <p role="alert" className="mt-2 text-sm text-fail-text">
          {start.error.message}
        </p>
      )}
      {signing && <SignDialog design={design} action={signing} onClose={() => setSigning(null)} />}
    </div>
  );
}

/** Lifecycle (F-022): what can happen next, the unmet conditions named, and the e-signed action. */
export function LifecycleSection({ design }: { design: DesignCard }) {
  const { t } = useTranslation();
  const { data: me } = useMe();
  const caps = me?.capabilities ?? [];
  const actions = actionsFor(design.status).filter((a) => caps.includes(CAP[a]));
  if (actions.length === 0) return null;
  const outcomes = [
    ['calculation', design.status !== 'draft' || design.lastVerdict === 'pass'],
    ['trial', ['trial_passed', 'approved', 'in_production', 'suspended'].includes(design.status)],
    ['approved', ['approved', 'in_production', 'suspended'].includes(design.status)],
    ['released', design.status === 'in_production'],
  ] as const;
  return (
    <section className="mt-6" aria-label={t('lifecycle.title')} data-testid="lifecycle-section">
      <h3 className="mb-2 text-sm font-semibold text-heading">{t('lifecycle.title')}</h3>
      <ol className="mb-3 flex flex-wrap gap-2 text-xs" data-testid="outcomes">
        {outcomes.map(([k, done]) => (
          <li
            key={k}
            data-outcome={k}
            data-done={done}
            className={`rounded-full border px-2 py-0.5 ${done ? 'border-pass-text text-pass-text' : 'border-line text-muted'}`}
          >
            {done ? '✓ ' : '○ '}
            {t(`lifecycle.outcome.${k}`)}
          </li>
        ))}
      </ol>
      <div className="flex flex-col gap-3">
        {actions.map((a) => (
          <Step key={a} design={design} action={a} />
        ))}
      </div>
    </section>
  );
}
