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
  Textarea,
  toast,
} from '@khalta/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../lib/api';
import { useMe } from '../lib/auth';
import { useFormat } from '../lib/format';
import { usePrefs } from '../lib/prefs';
import { materialsQuery } from '../materials/api';
import type { DesignCard, DesignLine } from './api';
import { CheckStatus } from './ComplianceTable';
import { VerdictChip } from './chips';
import { createVersion, previewEdit, type EditBody } from './portfolioApi';

const KG = /^\d{1,6}(\.\d{1,3})?$/;
interface Row {
  materialId: string;
  nameEn: string;
  nameAr: string | null;
  category: string;
  kg: string;
}

/** Edits become the NEXT version (a draft). The source version is never changed. */
export function EditorDialog({
  design,
  lines,
  onClose,
  onSaved,
}: {
  design: DesignCard;
  lines: DesignLine[];
  onClose: () => void;
  onSaved: (id: string) => void;
}) {
  const { t } = useTranslation();
  const { lang } = usePrefs();
  const f = useFormat();
  const { data: me } = useMe();
  const qc = useQueryClient();
  const r = design.requirements;
  const [rows, setRows] = useState<Row[]>(() =>
    lines.map((l) => ({
      materialId: l.materialId,
      nameEn: l.nameEn,
      nameAr: l.nameAr,
      category: l.category,
      kg: String(Number(l.quantityKgM3)),
    })),
  );
  const [slump, setSlump] = useState(r.slumpMm != null ? String(r.slumpMm) : '');
  const [air, setAir] = useState('');
  const [note, setNote] = useState('');
  const mats = useQuery(materialsQuery({}));
  const [add, setAdd] = useState('');

  const body = useMemo<EditBody | null>(() => {
    if (rows.length === 0 || rows.some((x) => !KG.test(x.kg) || Number(x.kg) <= 0)) return null;
    const requirements: Record<string, unknown> = {};
    if (slump.trim() !== '' && !Number.isNaN(Number(slump)) && Number(slump) > 0)
      requirements['slumpMm'] = Number(slump);
    if (air.trim() !== '' && !Number.isNaN(Number(air))) requirements['airPct'] = Number(air);
    return {
      mode: 'BOTH',
      requirements,
      lines: rows.map((x) => ({ materialId: x.materialId, kgPerM3: x.kg })),
    };
  }, [rows, slump, air]);
  const [debounced, setDebounced] = useState<EditBody | null>(body);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(body), 450);
    return () => clearTimeout(id);
  }, [body]);
  const preview = useQuery({
    queryKey: ['designs', 'preview', design.id, JSON.stringify(debounced)],
    queryFn: () => previewEdit(design.id, debounced!),
    enabled: !!debounced,
    retry: false,
  });
  const save = useMutation({
    mutationFn: () => {
      const { mode: _mode, ...edit } = body!;
      return createVersion(design.id, { ...edit, note: note.trim() });
    },
    onSuccess: async (res) => {
      await qc.invalidateQueries({ queryKey: ['designs'] });
      toast.success(t('editor.saved', { version: res.version }));
      onSaved(res.id);
    },
  });
  const err = save.error instanceof ApiError ? save.error.message : null;
  const canCost = (me?.capabilities ?? []).includes('cost.view');
  const used = new Set(rows.map((x) => x.materialId));
  const options = (mats.data ?? []).filter(
    (m) => !used.has(m.id) && (m.plantId === null || m.plantId === design.plantId),
  );
  const rep = preview.data?.report;
  const open = rep?.checks.filter((c) => c.status !== 'pass') ?? [];

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        closeLabel={t('ui.close')}
        className="max-h-[92vh] max-w-3xl overflow-y-auto"
        data-testid="editor-dialog"
      >
        <DialogTitle className="mb-1 text-lg font-semibold text-heading">
          {t('editor.title', { code: design.code })}
        </DialogTitle>
        <DialogDescription className="mb-4 text-sm text-muted">
          {t('editor.hint', { version: design.version })}
        </DialogDescription>

        <table className="w-full text-sm" data-testid="editor-lines">
          <caption className="sr-only">{t('library.lines')}</caption>
          <thead>
            <tr className="text-muted">
              <th scope="col" className="py-1 text-start font-medium">
                {t('library.line.material')}
              </th>
              <th scope="col" className="py-1 text-start font-medium">
                {t('library.line.kg')}
              </th>
              <th scope="col" className="py-1">
                <span className="sr-only">{t('editor.remove')}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((x, i) => (
              <tr key={x.materialId} className="border-t border-line" data-material={x.materialId}>
                <td className="py-1.5">
                  {lang === 'ar' ? (x.nameAr ?? x.nameEn) : x.nameEn}
                  <span className="block text-xs text-muted">
                    {t(`materials.category.${x.category}`)}
                  </span>
                </td>
                <td className="py-1.5">
                  <Input
                    dir="ltr"
                    inputMode="decimal"
                    className="w-32"
                    value={x.kg}
                    aria-label={`${lang === 'ar' ? (x.nameAr ?? x.nameEn) : x.nameEn}: ${t('library.line.kg')}`}
                    aria-invalid={!KG.test(x.kg) || Number(x.kg) <= 0}
                    data-testid="editor-kg"
                    onChange={(e) =>
                      setRows((p) => p.map((y, j) => (j === i ? { ...y, kg: e.target.value } : y)))
                    }
                  />
                </td>
                <td className="py-1.5">
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`${t('editor.remove')}: ${x.nameEn}`}
                    onClick={() => setRows((p) => p.filter((_, j) => j !== i))}
                  >
                    <Trash2 className="size-4" aria-hidden />
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="mt-2 flex items-end gap-2">
          <div className="flex flex-col gap-1">
            <Label htmlFor="ed-add">{t('editor.addMaterial')}</Label>
            <Select
              value={add}
              onValueChange={(v) => {
                const m = options.find((o) => o.id === v);
                if (m)
                  setRows((p) => [
                    ...p,
                    {
                      materialId: m.id,
                      nameEn: m.marketNameEn,
                      nameAr: m.marketNameAr,
                      category: m.category,
                      kg: '',
                    },
                  ]);
                setAdd('');
              }}
            >
              <SelectTrigger id="ed-add" className="w-72 max-w-full">
                <SelectValue placeholder={t('editor.choose')} />
              </SelectTrigger>
              <SelectContent>
                {options.map((m) => (
                  <SelectItem key={m.id} value={m.id}>
                    {lang === 'ar' ? (m.marketNameAr ?? m.marketNameEn) : m.marketNameEn}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Plus className="mb-2.5 size-4 text-muted" aria-hidden />
        </div>

        <div className="mt-4 grid grid-cols-2 gap-3">
          <div className="flex flex-col gap-1">
            <Label htmlFor="ed-slump">{t('library.field.slump')}</Label>
            <Input
              id="ed-slump"
              dir="ltr"
              inputMode="decimal"
              value={slump}
              onChange={(e) => setSlump(e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="ed-air">{t('evaluation.options.air')}</Label>
            <Input
              id="ed-air"
              dir="ltr"
              inputMode="decimal"
              value={air}
              onChange={(e) => setAir(e.target.value)}
            />
          </div>
        </div>

        <section
          className="mt-5 rounded-md border border-line p-3"
          aria-live="polite"
          data-testid="editor-preview"
        >
          <h3 className="mb-2 text-sm font-semibold text-heading">{t('editor.preview')}</h3>
          {!body && <p className="text-sm text-warn-text">{t('editor.invalid')}</p>}
          {body && preview.isFetching && (
            <p className="text-sm text-muted">{t('editor.calculating')}</p>
          )}
          {body && preview.isError && (
            <p role="alert" className="text-sm text-fail-text">
              {t('errors.loadFailed')}
            </p>
          )}
          {rep && !preview.isFetching && (
            <div className="flex flex-col gap-2 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <VerdictChip verdict={rep.verdict} />
                <span
                  data-testid="preview-validator"
                  data-validator={preview.data!.validator.status}
                >
                  {t(`evaluation.validator.${preview.data!.validator.status}`)}
                </span>
                {rep.provisional && (
                  <span className="text-xs text-muted">{t('evaluation.provisional')}</span>
                )}
              </div>
              <p>
                {t('evaluation.fig.wcm')}:{' '}
                <Ltr>
                  {f.number(Number(rep.figures['ratio.wcm']), { maximumFractionDigits: 3 })}
                </Ltr>{' '}
                · {t('evaluation.fig.yield')}:{' '}
                <Ltr>
                  {t('evaluation.unit.m3', {
                    n: f.number(Number(rep.figures['yield.delta']), { maximumFractionDigits: 4 }),
                  })}
                </Ltr>
                {canCost && rep.cost.totalJodPerM3 && (
                  <>
                    {' '}
                    · {t('evaluation.cost.total')}:{' '}
                    <strong data-testid="preview-cost">
                      <Ltr>
                        {t('evaluation.unit.jodm3', {
                          n: f.number(Number(rep.cost.totalJodPerM3), { maximumFractionDigits: 3 }),
                        })}
                      </Ltr>
                    </strong>
                  </>
                )}
              </p>
              {open.length > 0 && (
                <ul className="flex flex-col gap-1" data-testid="preview-open">
                  {open.map((c) => (
                    <li key={c.id} className="flex items-center gap-2">
                      <CheckStatus status={c.status} />
                      {t(`evaluation.check.${c.id.replace(/\./g, '_')}`, { defaultValue: c.id })}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </section>

        <div className="mt-4 flex flex-col gap-1">
          <Label htmlFor="ed-note">{t('editor.note')}</Label>
          <Textarea
            id="ed-note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            data-testid="editor-note"
          />
        </div>
        {err && (
          <p role="alert" className="mt-2 text-sm text-fail-text" data-testid="editor-error">
            {err}
          </p>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            {t('ui.cancel', { defaultValue: t('ui.close') })}
          </Button>
          <Button
            onClick={() => save.mutate()}
            disabled={!body || note.trim().length < 3 || save.isPending}
            data-testid="editor-save"
          >
            {t('editor.save')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
