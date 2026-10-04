import {
  Button,
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
  toast,
} from '@khalta/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../lib/api';
import { useMe } from '../lib/auth';
import { useFormat } from '../lib/format';
import { WhyDisabled } from '../lib/WhyDisabled';
import { decide, impactsQuery, type ImpactDisposition, type ImpactItem } from './impactApi';

const DISPOSITIONS: ImpactDisposition[] = [
  'revalidation_started',
  'requalification_required',
  'accepted_risk',
  'dismissed',
];

function DecideDialog({ item, onClose }: { item: ImpactItem; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [d, setD] = useState<ImpactDisposition>(
    item.class === 'requalify' ? 'requalification_required' : 'revalidation_started',
  );
  const [reason, setReason] = useState('');
  const m = useMutation({
    mutationFn: () => decide(item.id, d, reason.trim()),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['change-impacts'] });
      toast.success(t('impact.decided'));
      onClose();
    },
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent closeLabel={t('ui.close')} className="max-w-md" data-testid="impact-dialog">
        <DialogTitle className="mb-1 text-lg font-semibold text-heading">
          {t('impact.decide')} · <Ltr>{item.designCode}</Ltr>
        </DialogTitle>
        <DialogDescription className="mb-3 text-sm text-muted">
          {t('impact.decideHint')}
        </DialogDescription>
        <Label htmlFor="imp-d">{t('impact.decision')}</Label>
        <Select value={d} onValueChange={(v) => setD(v as ImpactDisposition)}>
          <SelectTrigger id="imp-d" data-testid="impact-decision">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {DISPOSITIONS.map((x) => (
              <SelectItem key={x} value={x}>
                {t(`impact.disposition.${x}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Label htmlFor="imp-r" className="mt-3 block">
          {t('impact.reason')}
        </Label>
        <Input
          id="imp-r"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          data-testid="impact-reason"
        />
        <WhyDisabled id="impact-why" reason={reason.trim().length < 10 ? t('impact.why') : null} />
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
            disabled={reason.trim().length < 10 || m.isPending}
            aria-describedby={reason.trim().length < 10 ? 'impact-why' : undefined}
            onClick={() => m.mutate()}
            data-testid="impact-save"
          >
            {t('impact.save')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** What recent changes touched and what a person decided. The designs themselves are never changed from here. */
export function ChangeImpactSection() {
  const { t } = useTranslation();
  const f = useFormat();
  const { data: me } = useMe();
  const q = useQuery(impactsQuery());
  const [deciding, setDeciding] = useState<ImpactItem | null>(null);
  const canDecide = me?.capabilities.includes('design.approve') ?? false;
  const impacts = (q.data ?? []).filter(
    (i) => i.jobState !== 'completed' || i.items.some((x) => x.class !== 'no_action'),
  );
  return (
    <section
      aria-label={t('impact.title')}
      className="flex flex-col gap-2"
      data-testid="change-impact"
    >
      <h2 className="text-lg font-semibold text-heading">{t('impact.title')}</h2>
      <p className="max-w-3xl text-sm text-muted">{t('impact.intro')}</p>
      {impacts.length === 0 && <p className="text-sm text-muted">{t('impact.none')}</p>}
      {impacts.map((i) => (
        <article
          key={i.id}
          className="rounded-md border border-line p-3"
          data-testid="impact-row"
          data-state={i.jobState}
        >
          <p className="text-sm font-medium text-heading">
            {t(`impact.trigger.${i.trigger}`)} · {t(`impact.state.${i.jobState}`)}{' '}
            <span className="text-xs text-muted">
              <Ltr>{f.dateTime(i.createdAt)}</Ltr>
            </span>
          </p>
          {i.jobState === 'failed' && (
            <p role="alert" className="text-sm text-fail-text">
              {t('impact.failed', { n: i.attempts })}
            </p>
          )}
          <ul className="mt-2 flex flex-col gap-1">
            {i.items
              .filter((x) => x.class !== 'no_action')
              .map((x) => (
                <li
                  key={x.id}
                  className="flex flex-wrap items-center gap-2 text-sm"
                  data-testid="impact-item"
                  data-class={x.class}
                >
                  <Ltr>{x.designCode}</Ltr>
                  <span className="text-muted">
                    {t('impact.version', { n: x.designVersion })} · {x.plantCode}
                  </span>
                  <span className="font-medium">{t(`impact.class.${x.class}`)}</span>
                  <span className="text-muted">
                    {x.reasons.map((r) => t(`impact.reason_${r}`, { defaultValue: r })).join(' · ')}
                  </span>
                  {x.disposition ? (
                    <span className="text-pass-text">
                      {t(`impact.disposition.${x.disposition}`)}
                    </span>
                  ) : (
                    canDecide && (
                      <Button
                        variant="secondary"
                        onClick={() => setDeciding(x)}
                        data-testid="impact-decide"
                      >
                        {t('impact.decide')}
                      </Button>
                    )
                  )}
                </li>
              ))}
          </ul>
        </article>
      ))}
      {deciding && <DecideDialog item={deciding} onClose={() => setDeciding(null)} />}
    </section>
  );
}
