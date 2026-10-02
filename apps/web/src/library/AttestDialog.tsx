import {
  Button,
  Checkbox,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  Input,
  Label,
  Textarea,
  toast,
} from '@khalta/ui';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../lib/api';
import { attestDesign, type DesignCard } from './api';

/** Records that a design was approved OUTSIDE Khalta. It does not say Khalta checked it. */
export function AttestDialog({
  design,
  onClose,
  isImporter,
}: {
  design: DesignCard;
  onClose: () => void;
  isImporter: boolean;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [ref, setRef] = useState(design.importedApprovalRef ?? '');
  const [date, setDate] = useState('');
  const [inProd, setInProd] = useState(design.importedInProduction ?? false);
  const [note, setNote] = useState('');
  const m = useMutation({
    mutationFn: () =>
      attestDesign(design.id, {
        approvalReference: ref.trim(),
        ...(date && { approvedOn: date }),
        inProduction: inProd,
        note: note.trim(),
      }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['designs'] });
      toast.success(t('library.attest.done'));
      onClose();
    },
  });
  const err = m.error instanceof ApiError ? m.error.message : null;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent closeLabel={t('ui.close')} className="max-w-xl" data-testid="attest-dialog">
        <DialogTitle className="mb-1 text-lg font-semibold text-heading">
          {t('library.attest.title', { code: design.code })}
        </DialogTitle>
        <DialogDescription className="mb-4 text-sm text-muted">
          {t('library.attest.hint')}
        </DialogDescription>
        {isImporter && (
          <p
            role="alert"
            className="mb-3 rounded-md bg-warn-bg p-3 text-sm text-warn-text"
            data-testid="four-eyes-note"
          >
            {t('library.attest.fourEyes')}
          </p>
        )}
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <Label htmlFor="a-ref">{t('library.attest.reference')}</Label>
            <Input
              id="a-ref"
              data-testid="attest-ref"
              value={ref}
              onChange={(e) => setRef(e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="a-date">{t('library.attest.date')}</Label>
            <Input
              id="a-date"
              type="date"
              dir="ltr"
              className="w-44"
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={inProd}
              onCheckedChange={(c) => setInProd(c === true)}
              data-testid="attest-in-production"
            />
            {t('library.attest.inProduction')}
          </label>
          <div className="flex flex-col gap-1">
            <Label htmlFor="a-note">{t('library.attest.note')}</Label>
            <Textarea
              id="a-note"
              data-testid="attest-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder={t('library.attest.notePlaceholder')}
            />
          </div>
        </div>
        <p className="mt-4 rounded-md bg-olive-tint p-3 text-sm text-olive-text">
          {t('library.attest.scope')}
        </p>
        {err && (
          <p role="alert" className="mt-3 text-sm text-fail-text" data-testid="attest-error">
            {err}
          </p>
        )}
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            {t('rules.cancel')}
          </Button>
          <Button
            disabled={ref.trim().length < 2 || note.trim().length < 5 || m.isPending}
            onClick={() => m.mutate()}
            data-testid="attest-submit"
          >
            {t('library.attest.submit')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
