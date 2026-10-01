import {
  Button,
  Dialog,
  DialogClose,
  DialogDescription,
  DialogTitle,
  Ltr,
  SheetContent,
  Skeleton,
  VerificationChip,
} from '@khalta/ui';
import { useQuery } from '@tanstack/react-query';
import { Pencil, ShieldCheck, X } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useFormat } from '../lib/format';
import { usePrefs } from '../lib/prefs';
import { ruleDetailQuery, type Rule } from './api';
import { EditDialog } from './EditDialog';
import { RuleValue, unitLabel } from './format';
import { TableGrid } from './TableGrid';
import { VerifyDialog } from './VerifyDialog';

// A <dl> may only contain <dt>/<dd> groups wrapped in a single <div>, so `wide` styles the group itself.
function Field({
  label,
  children,
  wide,
}: {
  label: string;
  children: React.ReactNode;
  wide?: boolean;
}) {
  return (
    <div className={`flex flex-col gap-0.5 ${wide ? 'col-span-2' : ''}`}>
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="text-sm">{children}</dd>
    </div>
  );
}

function AppliesTo({ applies }: { applies: Record<string, unknown> }) {
  const { t } = useTranslation();
  const entries = Object.entries(applies);
  if (entries.length === 0) return <span className="text-muted">{t('rules.always')}</span>;
  return (
    <span className="flex flex-wrap gap-1">
      {entries.map(([k, v]) => (
        <Ltr key={k} mono className="rounded-sm border border-line px-1 text-xs">
          {`${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`}
        </Ltr>
      ))}
    </span>
  );
}

export function RuleSheet({
  rule,
  onClose,
  canVerify,
  canEdit,
}: {
  rule: Rule | null;
  onClose: () => void;
  canVerify: boolean;
  canEdit: boolean;
}) {
  const { t } = useTranslation();
  const { lang } = usePrefs();
  const f = useFormat();
  const [verifyOpen, setVerifyOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const detail = useQuery({ ...ruleDetailQuery(rule?.id ?? ''), enabled: !!rule });
  // Always show the freshest data for the open rule (a verification or edit refetches the list).
  const live = rule;
  if (!live) return null;
  const note = lang === 'ar' ? (live.noteAr ?? live.noteEn) : (live.noteEn ?? live.noteAr);
  const other = lang === 'ar' ? live.noteEn : live.noteAr;

  return (
    <>
      <Dialog open onOpenChange={(o) => !o && onClose()}>
        <SheetContent
          side="end"
          className="w-[34rem] max-w-full overflow-y-auto"
          data-testid="rule-sheet"
        >
          <div className="mb-4 flex items-start justify-between gap-2">
            <div>
              <DialogTitle className="text-base font-semibold text-heading">
                <Ltr mono>{live.key}</Ltr>
              </DialogTitle>
              <DialogDescription className="mt-1 text-sm text-muted">{note}</DialogDescription>
            </div>
            <DialogClose asChild>
              <Button variant="ghost" size="icon" aria-label={t('ui.close')}>
                <X className="size-4" aria-hidden />
              </Button>
            </DialogClose>
          </div>

          <div className="mb-4 flex flex-wrap items-center gap-2">
            <VerificationChip state={live.status} />
            <span className="text-xs text-muted">{t('rules.version', { n: live.version })}</span>
          </div>

          <dl className="grid grid-cols-2 gap-4">
            <Field label={t('rules.col.value')}>
              <RuleValue rule={live} />
            </Field>
            <Field label={t('rules.field.units')}>
              <Ltr>{unitLabel(live.units) || live.units}</Ltr>
            </Field>
            <Field label={t('rules.col.class')}>
              {t(`rules.class.${live.requirementClass}`, { defaultValue: live.requirementClass })}
            </Field>
            <Field label={t('rules.field.kind')}>
              <Ltr mono className="text-xs">
                {live.kind}
              </Ltr>
            </Field>
            <Field label={t('rules.col.clause')}>
              <Ltr>{live.clauseRef}</Ltr>
            </Field>
            <Field label={t('rules.field.requirement')}>
              <Ltr mono className="text-xs">
                {live.requirement}
              </Ltr>
            </Field>
            <Field wide label={t('rules.field.appliesTo')}>
              <AppliesTo applies={live.appliesTo} />
            </Field>
            {other && (
              <Field wide label={t(lang === 'ar' ? 'rules.field.noteEn' : 'rules.field.noteAr')}>
                <span lang={lang === 'ar' ? 'en' : 'ar'}>{other}</span>
              </Field>
            )}
            <Field wide label={t('rules.col.usedBy')}>
              {live.usedByDesigns === 0 ? t('rules.usedByNone') : live.usedByDesigns}
            </Field>
          </dl>

          {live.definition && (
            <section className="mt-6" aria-label={t('rules.field.table')}>
              <h3 className="mb-2 text-sm font-semibold text-heading">{t('rules.field.table')}</h3>
              <TableGrid def={live.definition} />
            </section>
          )}

          {(canVerify || canEdit) && (
            <div className="mt-6 flex flex-wrap gap-2">
              {canVerify && live.status === 'unverified' && (
                <Button onClick={() => setVerifyOpen(true)} data-testid="verify-open">
                  <ShieldCheck className="size-4" aria-hidden />
                  {t('rules.verify.open')}
                </Button>
              )}
              {canEdit && (
                <Button
                  variant="secondary"
                  onClick={() => setEditOpen(true)}
                  data-testid="edit-open"
                >
                  <Pencil className="size-4" aria-hidden />
                  {t('rules.edit.open')}
                </Button>
              )}
            </div>
          )}

          <section className="mt-8" aria-label={t('rules.history.title')}>
            <h3 className="mb-2 text-sm font-semibold text-heading">{t('rules.history.title')}</h3>
            {detail.isLoading && <Skeleton className="h-12 w-full" />}
            {detail.data && (
              <ol className="flex flex-col gap-3">
                {detail.data.versions.map((v) => (
                  <li
                    key={v.id}
                    className="rounded-md border border-line p-3 text-sm"
                    data-version={v.version}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <strong>{t('rules.version', { n: v.version })}</strong>
                      <VerificationChip state={v.verified ? 'verified' : 'unverified'} />
                    </div>
                    <p className="mt-1 text-xs text-muted">
                      {t(`rules.origin.${v.origin}`, { defaultValue: v.origin })}
                      {v.createdByName ? ` · ${v.createdByName}` : ''} · {f.dateTime(v.createdAt)}
                    </p>
                    {v.changeReason && <p className="mt-1 text-xs">{v.changeReason}</p>}
                    {detail.data.verifications
                      .filter((x) => x.ruleId === v.id)
                      .map((x) => (
                        <p
                          key={x.id}
                          className="mt-2 border-s-2 border-pass ps-2 text-xs"
                          data-testid="verification-entry"
                        >
                          <span className="font-medium">{x.by}</span> · {f.dateTime(x.at)}
                          <span className="block text-muted">{x.note}</span>
                        </p>
                      ))}
                  </li>
                ))}
              </ol>
            )}
          </section>
        </SheetContent>
      </Dialog>
      {verifyOpen && <VerifyDialog rule={live} open onOpenChange={setVerifyOpen} />}
      {editOpen && <EditDialog key={live.id} rule={live} open onOpenChange={setEditOpen} />}
    </>
  );
}
