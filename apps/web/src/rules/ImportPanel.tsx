import { Button, Label, Ltr, Table, Td, Textarea, Th, toast } from '@khalta/ui';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CircleCheck, CircleX, Download, MinusCircle } from 'lucide-react';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import templateUrl from '../../../../templates/js-rule-values.csv?url';
import { ApiError } from '../lib/api';
import { commitImport, previewImport, type ImportPreview } from './api';
import { summarizeValue } from './format';

const STATUS_ICON = { ok: CircleCheck, unchanged: MinusCircle, error: CircleX } as const;
const STATUS_CLS = {
  ok: 'text-pass-text',
  unchanged: 'text-muted',
  error: 'text-fail-text',
} as const;

/** Upload → validation preview → commit. Nothing is written to the rules until the user commits. */
export function ImportPanel() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [text, setText] = useState('');
  const [filename, setFilename] = useState<string | undefined>();
  const [preview, setPreview] = useState<ImportPreview | null>(null);

  const doPreview = useMutation({
    mutationFn: () => previewImport(text, filename),
    onSuccess: setPreview,
  });
  const doCommit = useMutation({
    mutationFn: () => commitImport(preview!.batchId),
    onSuccess: async (r) => {
      await qc.invalidateQueries({ queryKey: ['rules'] });
      toast.success(t('rules.import.done', { count: r.applied }));
      setPreview(null);
      setText('');
      setFilename(undefined);
      if (fileRef.current) fileRef.current.value = '';
    },
  });

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    setFilename(file.name);
    setText(await file.text());
    setPreview(null);
  };
  const canCommit =
    !!preview &&
    preview.summary.errors === 0 &&
    preview.fileErrors.length === 0 &&
    preview.summary.ok > 0;
  const error =
    (doPreview.error ?? doCommit.error) instanceof ApiError
      ? (doPreview.error ?? doCommit.error)!.message
      : null;

  return (
    <div className="flex flex-col gap-6" data-testid="import-panel">
      <div className="max-w-2xl text-sm text-muted">
        <p>{t('rules.import.intro')}</p>
        <a
          href={templateUrl}
          download="js-rule-values.csv"
          className="mt-2 inline-flex items-center gap-1.5 text-primary underline"
        >
          <Download className="size-4" aria-hidden />
          {t('rules.import.template')}
        </a>
      </div>

      <div className="flex max-w-2xl flex-col gap-3">
        <Label htmlFor="csv-file">{t('rules.import.file')}</Label>
        <input
          id="csv-file"
          ref={fileRef}
          type="file"
          accept=".csv,text/csv"
          onChange={(e) => void onFile(e.target.files?.[0])}
          className="text-sm file:me-3 file:rounded-md file:border file:border-line file:bg-surface file:px-3 file:py-2 file:text-sm"
          data-testid="csv-file"
        />
        <Label htmlFor="csv-text">{t('rules.import.paste')}</Label>
        <Textarea
          id="csv-text"
          dir="ltr"
          className="min-h-32 font-mono text-xs"
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setPreview(null);
          }}
          data-testid="csv-text"
        />
        <div>
          <Button
            disabled={!text.trim() || doPreview.isPending}
            onClick={() => doPreview.mutate()}
            data-testid="import-preview"
          >
            {t('rules.import.preview')}
          </Button>
        </div>
        {error && (
          <p role="alert" className="text-sm text-fail-text">
            {error}
          </p>
        )}
      </div>

      {preview && (
        <section
          aria-label={t('rules.import.previewTitle')}
          data-testid="import-result"
          className="flex flex-col gap-3"
        >
          <h3 className="text-base font-semibold text-heading">{t('rules.import.previewTitle')}</h3>
          {preview.fileErrors.length > 0 && (
            <ul
              role="alert"
              className="list-disc rounded-md bg-fail-bg p-3 ps-8 text-sm text-fail-text"
              data-testid="file-errors"
            >
              {preview.fileErrors.map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          )}
          <p className="text-sm" data-testid="import-summary">
            {t('rules.import.summary', {
              total: preview.summary.total,
              ok: preview.summary.ok,
              unchanged: preview.summary.unchanged,
              errors: preview.summary.errors,
            })}
          </p>
          {preview.rows.length > 0 && (
            <div className="overflow-x-auto rounded-lg border border-line bg-surface">
              <Table>
                <thead>
                  <tr>
                    <Th numeric>{t('rules.import.line')}</Th>
                    <Th>{t('rules.col.rule')}</Th>
                    <Th>{t('rules.import.change')}</Th>
                    <Th>{t('rules.col.status')}</Th>
                  </tr>
                </thead>
                <tbody>
                  {preview.rows.map((r) => {
                    const Icon = STATUS_ICON[r.status];
                    return (
                      <tr key={r.line} data-row-status={r.status}>
                        <Td numeric>{r.line}</Td>
                        <Td>
                          <Ltr mono className="text-xs">
                            {r.ruleKey}
                          </Ltr>
                        </Td>
                        <Td className="text-xs">
                          {r.status === 'error' ? (
                            <ul className="list-disc ps-4 text-fail-text">
                              {r.errors.map((e) => (
                                <li key={e}>{e}</li>
                              ))}
                            </ul>
                          ) : (
                            <Ltr>
                              {`${summarizeValue('value', r.current?.value ?? null, null) ?? '∅'} → ${summarizeValue('value', r.proposed?.value ?? r.proposed?.inherits ?? null, null) ?? '∅'}`}
                            </Ltr>
                          )}
                        </Td>
                        <Td>
                          <span
                            className={`inline-flex items-center gap-1.5 text-xs font-medium ${STATUS_CLS[r.status]}`}
                          >
                            <Icon className="size-4" aria-hidden />
                            {t(`rules.import.status.${r.status}`)}
                          </span>
                        </Td>
                      </tr>
                    );
                  })}
                </tbody>
              </Table>
            </div>
          )}
          <div>
            <Button
              disabled={!canCommit || doCommit.isPending}
              onClick={() => doCommit.mutate()}
              data-testid="import-commit"
            >
              {t('rules.import.commit', { count: preview.summary.ok })}
            </Button>
            {!canCommit && preview.summary.errors > 0 && (
              <p className="mt-2 text-xs text-muted">{t('rules.import.fixFirst')}</p>
            )}
          </div>
        </section>
      )}
    </div>
  );
}
