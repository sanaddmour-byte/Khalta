import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  Input,
  Label,
  Ltr,
  Textarea,
  toast,
} from '@khalta/ui';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../lib/api';
import { editRule, type Rule, type TableDefinition } from './api';

type Parsed =
  | { ok: true; body: { value?: unknown; definition?: TableDefinition | null } }
  | { ok: false; error: string };

function initial(rule: Rule): string {
  if (rule.kind === 'table') return JSON.stringify(rule.definition, null, 2) ?? '';
  const v = rule.value;
  if (typeof v === 'number' || typeof v === 'string') return String(v);
  if (typeof v === 'boolean') return String(v);
  if (rule.kind === 'allowed_set' && Array.isArray(v)) return v.join('; ');
  return v === null || v === undefined ? '' : JSON.stringify(v, null, 2);
}

function parse(rule: Rule, text: string, t: (k: string) => string): Parsed {
  const s = text.trim();
  if (!s) return { ok: false, error: t('rules.edit.valueRequired') };
  try {
    switch (rule.kind) {
      case 'table':
        return { ok: true, body: { definition: JSON.parse(s) as TableDefinition } };
      case 'limit_max':
      case 'limit_min':
      case 'tolerance':
        if (/^\d+\/\d+$/.test(s)) return { ok: true, body: { value: s } };
        return Number.isFinite(Number(s))
          ? { ok: true, body: { value: Number(s) } }
          : { ok: false, error: t('rules.edit.notNumber') };
      case 'prohibition':
        return s === 'true' || s === 'false'
          ? { ok: true, body: { value: s === 'true' } }
          : { ok: false, error: t('rules.edit.boolean') };
      case 'allowed_set':
        return {
          ok: true,
          body: {
            value: s
              .split(';')
              .map((x) => x.trim())
              .filter(Boolean),
          },
        };
      default:
        return { ok: true, body: { value: JSON.parse(s) } };
    }
  } catch {
    return { ok: false, error: t('rules.edit.badJson') };
  }
}

/** Corrects a value. Never edits in place: the server creates a new, unverified version. */
export function EditDialog({
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
  const [text, setText] = useState(() => initial(rule));
  const [clause, setClause] = useState(rule.clauseRef);
  const [reason, setReason] = useState('');
  const parsed = parse(rule, text, t);
  const multiline =
    rule.kind === 'table' ||
    rule.kind === 'range' ||
    rule.kind === 'value' ||
    rule.kind === 'parameter' ||
    rule.kind === 'info';

  const m = useMutation({
    mutationFn: () => {
      if (!parsed.ok) throw new Error(parsed.error);
      return editRule(rule.id, {
        ...parsed.body,
        ...(clause.trim() !== rule.clauseRef ? { clause_ref: clause.trim() } : {}),
        reason: reason.trim(),
      });
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['rules'] });
      toast.success(t('rules.edit.done'));
      onOpenChange(false);
    },
  });
  const serverError = m.error instanceof ApiError ? m.error.message : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent closeLabel={t('ui.close')} data-testid="edit-dialog" className="max-w-xl">
        <DialogTitle className="mb-1 text-lg font-semibold text-heading">
          {t('rules.edit.title')}
        </DialogTitle>
        <DialogDescription className="mb-4 text-sm text-muted">
          {t('rules.edit.description', { version: rule.version + 1 })}
        </DialogDescription>
        <p className="mb-4 text-sm">
          <Ltr mono>{rule.key}</Ltr>
        </p>
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="edit-value">
              {t('rules.edit.value')}{' '}
              {rule.units !== 'none' && rule.units !== 'ratio' && rule.units !== 'fraction' ? (
                <Ltr className="text-muted">({rule.units})</Ltr>
              ) : null}
            </Label>
            {multiline ? (
              <Textarea
                id="edit-value"
                dir="ltr"
                className="min-h-40 font-mono text-xs"
                value={text}
                onChange={(e) => setText(e.target.value)}
                aria-invalid={!parsed.ok}
              />
            ) : (
              <Input
                id="edit-value"
                dir="ltr"
                value={text}
                onChange={(e) => setText(e.target.value)}
                aria-invalid={!parsed.ok}
              />
            )}
            <p className="text-xs text-muted">
              {t(`rules.edit.hint.${rule.kind}`, { defaultValue: t('rules.edit.hint.default') })}
            </p>
            {!parsed.ok && <p className="text-xs text-fail-text">{parsed.error}</p>}
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="edit-clause">{t('rules.edit.clause')}</Label>
            <Input
              id="edit-clause"
              dir="ltr"
              value={clause}
              onChange={(e) => setClause(e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="edit-reason">{t('rules.edit.reason')}</Label>
            <Textarea
              id="edit-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder={t('rules.edit.reasonPlaceholder')}
            />
          </div>
        </div>
        <p className="mt-4 rounded-md bg-warn-bg p-3 text-sm text-warn-text">
          {t('rules.edit.warning')}
        </p>
        {serverError && (
          <p role="alert" className="mt-3 text-sm text-fail-text" data-testid="edit-error">
            {serverError}
          </p>
        )}
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            {t('rules.cancel')}
          </Button>
          <Button
            disabled={!parsed.ok || reason.trim().length < 5 || m.isPending}
            onClick={() => m.mutate()}
            data-testid="edit-submit"
          >
            {t('rules.edit.submit')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
