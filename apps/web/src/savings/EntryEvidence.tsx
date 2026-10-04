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
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../lib/api';
import { useMe } from '../lib/auth';
import { WhyDisabled } from '../lib/WhyDisabled';
import { adjustEntry, type AdjustmentKind, type SavingsEntry } from '../library/portfolioApi';

const KINDS: AdjustmentKind[] = ['trial_cost', 'implementation_cost', 'extra_cost', 'reversal'];

function AdjustDialog({ entry, onClose }: { entry: SavingsEntry; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [kind, setKind] = useState<AdjustmentKind>('trial_cost');
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const m = useMutation({
    mutationFn: () =>
      adjustEntry(entry.id, {
        kind,
        note: note.trim(),
        ...(kind !== 'reversal' && { amountJod: amount.trim() }),
      }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['savings'] });
      toast.success(t('savings.evidence.saved'));
      onClose();
    },
  });
  const ready =
    note.trim().length >= 10 && (kind === 'reversal' || /^\d+(\.\d{1,3})?$/.test(amount.trim()));
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent closeLabel={t('ui.close')} className="max-w-md" data-testid="adjust-dialog">
        <DialogTitle className="mb-1 text-lg font-semibold text-heading">
          {t('savings.evidence.adjust')}
        </DialogTitle>
        <DialogDescription className="mb-3 text-sm text-muted">
          {t('savings.evidence.adjustHint')}
        </DialogDescription>
        <Label htmlFor="adj-kind">{t('savings.evidence.kindLabel')}</Label>
        <Select value={kind} onValueChange={(v) => setKind(v as AdjustmentKind)}>
          <SelectTrigger id="adj-kind" data-testid="adjust-kind">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {KINDS.map((k) => (
              <SelectItem key={k} value={k}>
                {t(`savings.evidence.kind.${k}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {kind !== 'reversal' && (
          <>
            <Label htmlFor="adj-amount" className="mt-3 block">
              {t('savings.evidence.amount')}
            </Label>
            <Input
              id="adj-amount"
              dir="ltr"
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              data-testid="adjust-amount"
            />
          </>
        )}
        <Label htmlFor="adj-note" className="mt-3 block">
          {t('savings.evidence.note')}
        </Label>
        <Input
          id="adj-note"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          data-testid="adjust-note"
        />
        <WhyDisabled
          id="adjust-why"
          reason={
            ready
              ? null
              : note.trim().length < 10
                ? t('savings.evidence.why.note')
                : t('savings.evidence.why.amount')
          }
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
            disabled={!ready || m.isPending}
            aria-describedby={ready ? undefined : 'adjust-why'}
            onClick={() => m.mutate()}
            data-testid="adjust-save"
          >
            {t('savings.evidence.save')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** What a booked figure stands on: period, volume source, reconciliation, gross / costs / net, and corrections. */
export function EntryEvidence({ entry }: { entry: SavingsEntry }) {
  const { t } = useTranslation();
  const { data: me } = useMe();
  const [open, setOpen] = useState(false);
  if (entry.state === 'theoretical') return null;
  const canAdjust = me?.capabilities.includes('insight.accept') ?? false;
  return (
    <div className="mt-1 border-t border-line pt-1 text-xs" data-testid="entry-evidence">
      {entry.attribution && (
        <p className="text-muted">
          {t('savings.evidence.period')}{' '}
          <Ltr>
            {entry.attribution.from} → {entry.attribution.to}
          </Ltr>
        </p>
      )}
      {entry.state === 'realized' && (
        <p className="text-muted">
          {t('savings.evidence.volumeSource')}:{' '}
          {entry.volumeSource
            ? t(`savings.evidence.source.${entry.volumeSource}`)
            : t('savings.evidence.source.none')}
        </p>
      )}
      {entry.reconciliation && (
        <p
          className={entry.reconciliation === 'reconciled' ? 'text-pass-text' : 'text-warn-text'}
          data-testid="reconciliation"
          data-status={entry.reconciliation}
        >
          {t(`savings.evidence.reconciliation.${entry.reconciliation}`)}
        </p>
      )}
      {entry.net && (entry.net.costs !== '0.000' || entry.net.reversed) && (
        <p className="text-muted" data-testid="entry-net">
          {t('savings.evidence.net', {
            gross: entry.net.gross,
            costs: entry.net.costs,
            net: entry.net.net,
          })}
          {entry.net.reversed && <> · {t('savings.evidence.reversed')}</>}
        </p>
      )}
      {entry.adjustments.map((a) => (
        <p key={a.id} className="text-muted">
          {t(`savings.evidence.kind.${a.kind}`)} · <Ltr>{a.amountJod}</Ltr> · {a.note}
        </p>
      ))}
      {canAdjust && (
        <Button variant="ghost" onClick={() => setOpen(true)} data-testid="adjust-open">
          {t('savings.evidence.adjust')}
        </Button>
      )}
      {open && <AdjustDialog entry={entry} onClose={() => setOpen(false)} />}
    </div>
  );
}
