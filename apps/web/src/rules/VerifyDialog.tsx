import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  Label,
  Ltr,
  Textarea,
  toast,
} from '@khalta/ui';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../lib/api';
import { verifyRule, type Rule } from './api';

/** Regulated action: a typed e-signature note is required (03-ui.md §2.8). */
export function VerifyDialog({
  rule,
  open,
  onOpenChange,
}: {
  rule: Rule;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [note, setNote] = useState('');
  const m = useMutation({
    mutationFn: () => verifyRule(rule.id, note.trim()),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['rules'] });
      toast.success(t('rules.verify.done'));
      setNote('');
      onOpenChange(false);
    },
  });
  const message = m.error instanceof ApiError ? m.error.message : null;
  const valid = note.trim().length >= 5;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent closeLabel={t('ui.close')} data-testid="verify-dialog">
        <DialogTitle className="mb-1 text-lg font-semibold text-heading">
          {t('rules.verify.title')}
        </DialogTitle>
        <DialogDescription className="mb-4 text-sm text-muted">
          {t('rules.verify.description')}
        </DialogDescription>
        <p className="mb-4 rounded-md bg-app p-3 text-sm">
          <Ltr mono>{rule.key}</Ltr>
          <span className="block text-muted">
            <Ltr>{rule.clauseRef}</Ltr>
          </span>
        </p>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="verify-note">{t('rules.verify.noteLabel')}</Label>
          <Textarea
            id="verify-note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder={t('rules.verify.notePlaceholder')}
            aria-invalid={m.isError}
          />
          <p className="text-xs text-muted">{t('rules.verify.noteHint')}</p>
        </div>
        {message && (
          <p role="alert" className="mt-3 text-sm text-fail-text" data-testid="verify-error">
            {message}
          </p>
        )}
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            {t('rules.cancel')}
          </Button>
          <Button
            disabled={!valid || m.isPending}
            onClick={() => m.mutate()}
            data-testid="verify-submit"
          >
            {t('rules.verify.submit')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
