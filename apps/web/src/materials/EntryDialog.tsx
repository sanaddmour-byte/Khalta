import {
  DEFAULT_FM_SIEVES,
  fineModulus,
  parseGradationPaste,
  parseProperties,
  sanityWarnings,
  validateGradation,
  validateWaterReduction,
  CATEGORIES,
  SOURCES,
  suggestCementLabel,
  type Category,
  type GradationPoint,
  type Properties,
  type Source,
} from '@khalta/engine';
import {
  Button,
  Checkbox,
  Dialog,
  DialogClose,
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
  SheetContent,
  Textarea,
  toast,
} from '@khalta/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CloudOff, Plus, Trash2, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../lib/api';
import { useMe } from '../lib/auth';
import { useFormat } from '../lib/format';
import { usePlant } from '../lib/plant';
import { usePrefs } from '../lib/prefs';
import {
  addTest,
  createMaterial,
  paramsQuery,
  suppliersQuery,
  uploadAttachment,
  type Material,
  type MaterialTest,
} from './api';
import { clearDraft, loadDraft, saveDraft, type Draft } from './drafts';
import { fieldsFor, type FieldDef } from './fields';
import { cementText } from './cementText';
import { parseNumber } from './number';

export type EntryTarget =
  | { kind: 'new' }
  | { kind: 'test'; material: Material; current: MaterialTest | null; upgrade?: boolean };

const today = () => new Date().toISOString().slice(0, 10);
const NONE = '__none';

function initialValues(current: MaterialTest | null) {
  const values: Record<string, string> = {};
  const props = current?.properties ?? {};
  for (const [k, v] of Object.entries(props))
    if (typeof v === 'number' || typeof v === 'string') values[k] = String(v);
  return {
    values,
    gradation: ((props['sieve_analysis'] as GradationPoint[] | undefined) ?? []).map((p) => ({
      ...p,
    })),
    table: (
      (props['water_reduction_table'] as
        { dosage_pct: number; water_reduction_pct: number }[] | undefined) ?? []
    ).map((r) => ({
      dosage_pct: String(r.dosage_pct),
      water_reduction_pct: String(r.water_reduction_pct),
    })),
    sgConfirmed: props['sg_confirmed'] === true,
  };
}

/** Quick entry of a material and/or a new test version (F-007). Drafts are kept locally while typing. */
export function EntryDialog({
  target,
  onClose,
  onSaved,
}: {
  target: EntryTarget;
  onClose: () => void;
  onSaved?: (materialId: string) => void;
}) {
  const { t } = useTranslation();
  const { lang } = usePrefs();
  const f = useFormat();
  const qc = useQueryClient();
  const { data: me } = useMe();
  const { plants, selected } = usePlant();
  const suppliers = useQuery(suppliersQuery);
  const params = useQuery(paramsQuery);
  const isNew = target.kind === 'new';
  const upgrade = target.kind === 'test' && !!target.upgrade;
  const draftKey = target.kind === 'new' ? 'new' : target.material.id;
  const userId = me?.user.id ?? '';
  const canCreate = (me?.capabilities ?? []).includes('materials.write');

  const base = useMemo(
    () => initialValues(target.kind === 'test' ? target.current : null),
    [target],
  );
  const [category, setCategory] = useState<Category>(
    target.kind === 'test' ? target.material.category : 'fine_agg',
  );
  const [nameEn, setNameEn] = useState('');
  const [nameAr, setNameAr] = useState('');
  const [sourceName, setSourceName] = useState('');
  const [plantId, setPlantId] = useState(selected && selected !== 'all' ? selected : NONE);
  const [supplierId, setSupplierId] = useState(NONE);
  const [values, setValues] = useState(base.values);
  const [gradation, setGradation] = useState<GradationPoint[]>(base.gradation);
  const [table, setTable] = useState(base.table);
  const [sgConfirmed, setSgConfirmed] = useState(base.sgConfirmed);
  const [paste, setPaste] = useState('');
  const [pasteInfo, setPasteInfo] = useState<{ assumptions: string[]; errors: string[] } | null>(
    null,
  );
  const [source, setSource] = useState<Source>(upgrade ? 'lab_report' : 'user_declared');
  const [testedAt, setTestedAt] = useState(today());
  const [labRef, setLabRef] = useState('');
  const [reason, setReason] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [createdId, setCreatedId] = useState<string | null>(null);
  const [restored, setRestored] = useState<Draft | null>(null);
  const [online, setOnline] = useState(() => navigator.onLine);
  const fileInput = useRef<HTMLInputElement>(null);

  // Offer a saved draft once; autosave every change afterwards.
  useEffect(() => {
    if (userId) setRestored(loadDraft(userId, draftKey));
  }, [userId, draftKey]);
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);
  const dirty = Object.keys(values).length > 0 || gradation.length > 0 || table.length > 0;
  useEffect(() => {
    if (!userId || !dirty || restored) return;
    const id = setTimeout(
      () =>
        saveDraft(userId, draftKey, {
          values,
          gradation,
          table,
          extra: { nameEn, nameAr, sourceName },
        }),
      400,
    );
    return () => clearTimeout(id);
  }, [userId, draftKey, dirty, restored, values, gradation, table, nameEn, nameAr, sourceName]);

  const fields = useMemo(() => fieldsFor(category), [category]);
  const hasGradation = category === 'fine_agg' || category === 'coarse_agg';
  const isAdmixture = category === 'admixture';

  const { props, fieldErrors } = useMemo(() => {
    const p: Record<string, unknown> = {};
    const errs: Record<string, string> = {};
    for (const d of fields) {
      const raw = (values[d.key] ?? '').trim();
      if (raw === '') continue;
      if (d.type === 'number') {
        const n = parseNumber(raw);
        if (n === null) errs[d.key] = t('materials.err.notNumber');
        else p[d.key] = n;
      } else p[d.key] = d.numeric ? Number(raw) : raw;
    }
    if (hasGradation && gradation.length > 0) p['sieve_analysis'] = gradation;
    if (isAdmixture && table.length > 0)
      p['water_reduction_table'] = table.map((r) => ({
        dosage_pct: parseNumber(r.dosage_pct) ?? Number.NaN,
        water_reduction_pct: parseNumber(r.water_reduction_pct) ?? Number.NaN,
      }));
    if (category === 'water' && sgConfirmed) p['sg_confirmed'] = true;
    const parsed = parseProperties(category, p);
    if (!parsed.ok)
      for (const e of parsed.errors)
        if (!errs[e.path.split('.')[0]!]) errs[e.path.split('.')[0]!] = e.message;
    return { props: p as Properties, fieldErrors: errs };
  }, [fields, values, gradation, table, sgConfirmed, category, hasGradation, isAdmixture, t]);

  const gradErrors = useMemo(
    () => (gradation.length ? validateGradation(gradation) : []),
    [gradation],
  );
  const wrErrors = useMemo(
    () => (isAdmixture ? validateWaterReduction(props) : []),
    [isAdmixture, props],
  );
  const fm = useMemo(
    () =>
      gradation.length && gradErrors.length === 0
        ? fineModulus(gradation, params.data?.fmSieves ?? DEFAULT_FM_SIEVES)
        : null,
    [gradation, gradErrors, params.data],
  );
  const warnings = useMemo(
    () => sanityWarnings(category, props, me?.settings.sanityRanges ?? {}),
    [category, props, me],
  );

  const propCount = Object.keys(props).length;
  const needsFile = source === 'lab_report';
  const needsReason = source === 'user_declared';
  const blocked =
    (isNew && !nameEn.trim()) ||
    propCount === 0 ||
    Object.keys(fieldErrors).length > 0 ||
    gradErrors.length > 0 ||
    wrErrors.length > 0 ||
    (needsFile && !file) ||
    (needsReason && reason.trim().length < 3);

  const save = useMutation({
    mutationFn: async () => {
      let materialId = target.kind === 'test' ? target.material.id : createdId;
      if (!materialId) {
        const m = await createMaterial({
          category,
          marketNameEn: nameEn.trim(),
          marketNameAr: nameAr.trim() || null,
          sourceName: sourceName.trim() || null,
          plantId: plantId === NONE ? null : plantId,
          supplierId: supplierId === NONE ? null : supplierId,
        });
        materialId = m.id;
        setCreatedId(m.id); // a retry after a failed test must not create the material twice
      }
      const attachmentId = file ? (await uploadAttachment(file)).id : undefined;
      const prev = target.kind === 'test' ? target.current : null;
      const fieldSources: Record<string, Source> | undefined = upgrade
        ? Object.fromEntries(
            Object.keys(props)
              .filter((k) => prev?.fieldSources[k] && prev.fieldSources[k] !== 'lab_report')
              .map((k) => [k, 'lab_report' as Source]),
          )
        : undefined;
      const result = await addTest(materialId, {
        properties: props,
        source,
        ...(fieldSources && { fieldSources }),
        testedAt,
        ...(labRef.trim() && { labRef: labRef.trim() }),
        ...(attachmentId && { attachmentId }),
        ...(needsReason && { declaredReason: reason.trim() }),
      });
      return { materialId, result };
    },
    onSuccess: async ({ materialId, result }) => {
      clearDraft(userId, draftKey);
      await qc.invalidateQueries({ queryKey: ['materials'] });
      toast.success(t('materials.entry.saved', { version: result.test.version }));
      if (result.warnings.length)
        toast.warning(t('materials.entry.warnings', { count: result.warnings.length }));
      onSaved?.(materialId);
      onClose();
    },
  });
  const serverError =
    save.error instanceof ApiError ? save.error.message : save.error ? t('errors.network') : null;

  function applyPaste() {
    const r = parseGradationPaste(paste);
    setPasteInfo({ assumptions: r.assumptions, errors: r.errors });
    if (r.points.length > 0 && r.errors.length === 0) {
      setGradation(r.points);
      setPaste('');
    }
  }
  function restore() {
    if (!restored) return;
    setValues(restored.values);
    setGradation(restored.gradation);
    setTable(restored.table);
    setNameEn(restored.extra['nameEn'] ?? '');
    setNameAr(restored.extra['nameAr'] ?? '');
    setSourceName(restored.extra['sourceName'] ?? '');
    setRestored(null);
  }
  const setVal = (k: string, v: string) => setValues((s) => ({ ...s, [k]: v }));

  const matName =
    target.kind === 'test'
      ? lang === 'ar'
        ? (target.material.marketNameAr ?? target.material.marketNameEn)
        : target.material.marketNameEn
      : null;
  const cementSuggestion =
    category === 'cement' && !values['cement_kind'] && !values['cement_strength_class']
      ? suggestCementLabel([nameEn, nameAr, matName ?? ''].join(' '))
      : null;
  const hasSuggestion =
    !!cementSuggestion && (!!cementSuggestion.kind || !!cementSuggestion.strengthClass);

  const tiers: ['evaluate' | 'design' | 'optional', FieldDef[]][] = (
    ['evaluate', 'design', 'optional'] as const
  ).map((tier) => [tier, fields.filter((d) => d.tier === tier && d.key !== 'sg_confirmed')]);

  const renderField = (d: FieldDef) => {
    const id = `f-${d.key}`;
    const err = fieldErrors[d.key];
    return (
      <div key={d.key} className="flex flex-col gap-1">
        <Label htmlFor={id}>{t(`materials.field.${d.key}`)}</Label>
        <div className="flex items-center gap-2">
          {d.type === 'select' ? (
            <Select
              value={values[d.key] || NONE}
              onValueChange={(v) => setVal(d.key, v === NONE ? '' : v)}
            >
              <SelectTrigger id={id} aria-label={t(`materials.field.${d.key}`)}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>{t('materials.entry.unset')}</SelectItem>
                {d.options!.map((o) => (
                  <SelectItem key={o} value={o}>
                    {t(`materials.opt.${d.key}.${o}`, { defaultValue: o })}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <Input
              id={id}
              data-testid={id}
              inputMode={d.type === 'number' ? 'decimal' : 'text'}
              dir={d.type === 'number' ? 'ltr' : undefined}
              className="h-12 text-base sm:h-10 sm:text-sm"
              value={values[d.key] ?? ''}
              aria-invalid={!!err}
              aria-describedby={err ? `${id}-err` : undefined}
              onChange={(e) => setVal(d.key, e.target.value)}
            />
          )}
          {d.unit && <Ltr className="w-24 shrink-0 text-xs text-muted">{d.unit}</Ltr>}
        </div>
        {err && (
          <p id={`${id}-err`} className="text-xs text-fail-text">
            {err}
          </p>
        )}
      </div>
    );
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <SheetContent
        side="end"
        className="w-[40rem] max-w-full overflow-y-auto"
        data-testid="entry-dialog"
        aria-describedby="entry-desc"
      >
        <div className="mb-3 flex items-start justify-between gap-2">
          <div>
            <DialogTitle className="text-lg font-semibold text-heading">
              {isNew
                ? t('materials.entry.titleNew')
                : upgrade
                  ? t('materials.entry.titleUpgrade', { name: matName })
                  : t('materials.entry.titleTest', { name: matName })}
            </DialogTitle>
            <DialogDescription id="entry-desc" className="mt-1 text-sm text-muted">
              {t('materials.entry.intro')}
            </DialogDescription>
          </div>
          <DialogClose asChild>
            <Button variant="ghost" size="icon" aria-label={t('ui.close')}>
              <X className="size-4" aria-hidden />
            </Button>
          </DialogClose>
        </div>

        {!online && (
          <p
            role="status"
            className="mb-3 flex items-center gap-2 rounded-md bg-warn-bg p-3 text-sm text-warn-text"
            data-testid="offline-banner"
          >
            <CloudOff className="size-4 shrink-0" aria-hidden />
            {t('materials.entry.offline')}
          </p>
        )}
        {restored && (
          <div
            role="status"
            className="mb-3 flex flex-wrap items-center gap-2 rounded-md bg-olive-tint p-3 text-sm text-olive-text"
            data-testid="draft-banner"
          >
            <span className="grow">
              {t('materials.entry.draftFound', { when: f.dateTime(restored.savedAt) })}
            </span>
            <Button size="sm" variant="secondary" onClick={restore}>
              {t('materials.entry.draftRestore')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                clearDraft(userId, draftKey);
                setRestored(null);
              }}
            >
              {t('materials.entry.draftDiscard')}
            </Button>
          </div>
        )}

        {isNew && (
          <section
            className="mb-5 grid grid-cols-1 gap-3 sm:grid-cols-2"
            aria-label={t('materials.entry.identity')}
          >
            <div className="flex flex-col gap-1">
              <Label htmlFor="m-cat">{t('materials.col.category')}</Label>
              <Select value={category} onValueChange={(v) => setCategory(v as Category)}>
                <SelectTrigger id="m-cat" aria-label={t('materials.col.category')}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CATEGORIES.map((c) => (
                    <SelectItem key={c} value={c}>
                      {t(`materials.category.${c}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="m-en">{t('materials.entry.nameEn')}</Label>
              <Input
                id="m-en"
                data-testid="m-name-en"
                dir="ltr"
                value={nameEn}
                onChange={(e) => setNameEn(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="m-ar">{t('materials.entry.nameAr')}</Label>
              <Input
                id="m-ar"
                data-testid="m-name-ar"
                dir="rtl"
                lang="ar"
                value={nameAr}
                onChange={(e) => setNameAr(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="m-src">{t('materials.entry.sourceName')}</Label>
              <Input
                id="m-src"
                value={sourceName}
                onChange={(e) => setSourceName(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="m-plant">{t('materials.col.plant')}</Label>
              <Select value={plantId} onValueChange={setPlantId}>
                <SelectTrigger id="m-plant" aria-label={t('materials.col.plant')}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>{t('materials.entry.allPlants')}</SelectItem>
                  {plants.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {lang === 'ar' ? p.nameAr : p.nameEn}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="m-sup">{t('materials.col.supplier')}</Label>
              <Select value={supplierId} onValueChange={setSupplierId}>
                <SelectTrigger id="m-sup" aria-label={t('materials.col.supplier')}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>{t('materials.entry.unset')}</SelectItem>
                  {(suppliers.data ?? []).map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {lang === 'ar' ? s.nameAr : s.nameEn}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </section>
        )}

        {category === 'cement' && (
          <p className="mb-3 text-xs text-muted">{t('materials.cement.hint')}</p>
        )}
        {hasSuggestion && cementSuggestion && (
          <div
            className="mb-4 flex flex-wrap items-center gap-2 rounded-md border border-line p-2 text-sm"
            data-testid="cement-suggestion"
          >
            <span>
              {t('materials.cement.suggest', {
                label: cementText(t, cementSuggestion.kind, cementSuggestion.strengthClass),
              })}
            </span>
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                if (cementSuggestion.kind) setVal('cement_kind', cementSuggestion.kind);
                if (cementSuggestion.strengthClass)
                  setVal('cement_strength_class', String(cementSuggestion.strengthClass));
              }}
            >
              {t('materials.cement.apply')}
            </Button>
          </div>
        )}

        {tiers.map(([tier, list]) =>
          list.length === 0 && !(tier === 'design' && (hasGradation || isAdmixture)) ? null : (
            <section key={tier} className="mb-5" aria-label={t(`materials.tier.${tier}`)}>
              <h3 className="mb-1 text-sm font-semibold text-heading">
                {t(`materials.tier.${tier}`)}
              </h3>
              <p className="mb-2 text-xs text-muted">{t(`materials.tier.${tier}Hint`)}</p>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">{list.map(renderField)}</div>

              {tier === 'evaluate' && category === 'water' && (
                <label className="mt-3 flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={sgConfirmed}
                    onCheckedChange={(c) => setSgConfirmed(c === true)}
                    data-testid="sg-confirmed"
                  />
                  {t('materials.entry.sgConfirmed')}
                </label>
              )}

              {tier === 'design' && hasGradation && (
                <div
                  className="mt-4 rounded-md border border-line p-3"
                  data-testid="gradation-entry"
                >
                  <h4 className="mb-1 text-sm font-medium text-heading">
                    {t('materials.field.sieve_analysis')}
                  </h4>
                  <p className="mb-2 text-xs text-muted">{t('materials.entry.pasteHint')}</p>
                  <Label htmlFor="paste" className="sr-only">
                    {t('materials.entry.pasteLabel')}
                  </Label>
                  <Textarea
                    id="paste"
                    data-testid="paste-input"
                    dir="ltr"
                    className="min-h-20 font-mono text-xs"
                    placeholder={
                      '9.5\t4.75\t2.36\t1.18\t0.6\t0.3\t0.15\n100\t95\t80\t60\t40\t15\t5'
                    }
                    value={paste}
                    onChange={(e) => setPaste(e.target.value)}
                  />
                  <div className="mt-2 flex gap-2">
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={applyPaste}
                      disabled={!paste.trim()}
                      data-testid="paste-apply"
                    >
                      {t('materials.entry.pasteApply')}
                    </Button>
                    {gradation.length > 0 && (
                      <Button size="sm" variant="ghost" onClick={() => setGradation([])}>
                        <Trash2 className="size-4" aria-hidden />
                        {t('materials.entry.gradationClear')}
                      </Button>
                    )}
                  </div>
                  {pasteInfo && pasteInfo.errors.length > 0 && (
                    <ul
                      role="alert"
                      className="mt-2 list-disc ps-5 text-xs text-fail-text"
                      data-testid="paste-errors"
                    >
                      {pasteInfo.errors.map((e) => (
                        <li key={e}>{e}</li>
                      ))}
                    </ul>
                  )}
                  {pasteInfo &&
                    pasteInfo.errors.length === 0 &&
                    pasteInfo.assumptions.length > 0 && (
                      <ul
                        className="mt-2 list-disc ps-5 text-xs text-muted"
                        data-testid="paste-assumptions"
                      >
                        {pasteInfo.assumptions.map((a) => (
                          <li key={a}>{a}</li>
                        ))}
                      </ul>
                    )}
                  {gradation.length > 0 && (
                    <div className="mt-3 overflow-x-auto">
                      <table className="w-full text-xs" data-testid="gradation-table">
                        <caption className="sr-only">{t('materials.field.sieve_analysis')}</caption>
                        <thead>
                          <tr className="text-start text-muted">
                            <th scope="col" className="py-1 text-start font-medium">
                              {t('materials.chart.sieve')}
                            </th>
                            <th scope="col" className="py-1 text-start font-medium">
                              {t('materials.chart.passing')}
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          {[...gradation]
                            .sort((a, b) => b.sieve_mm - a.sieve_mm)
                            .map((p) => (
                              <tr key={p.sieve_mm}>
                                <td className="py-0.5">
                                  <Ltr>{f.number(p.sieve_mm)}</Ltr>
                                </td>
                                <td className="py-0.5">
                                  <Ltr>{f.number(p.passing_pct)}</Ltr>
                                </td>
                              </tr>
                            ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                  {gradErrors.length > 0 && (
                    <ul
                      role="alert"
                      className="mt-2 list-disc ps-5 text-xs text-fail-text"
                      data-testid="gradation-errors"
                    >
                      {gradErrors.map((e, i) => (
                        <li key={i}>
                          {t(`materials.gradErr.${e.code}`, {
                            sieve: e.sieve_mm !== undefined ? f.number(e.sieve_mm) : '',
                          })}
                        </li>
                      ))}
                    </ul>
                  )}
                  {fm && (
                    <p className="mt-2 text-sm" data-testid="fm-live" aria-live="polite">
                      <span className="text-muted">{t('materials.fm')}: </span>
                      {fm.ok ? (
                        <strong>
                          <Ltr>
                            {f.number(fm.fm, {
                              minimumFractionDigits: 2,
                              maximumFractionDigits: 2,
                            })}
                          </Ltr>
                        </strong>
                      ) : (
                        <span className="text-warn-text">
                          {t('materials.fmMissing', {
                            sieves: fm.missing.map((s) => f.number(s)).join(', '),
                          })}
                        </span>
                      )}
                    </p>
                  )}
                </div>
              )}

              {tier === 'design' && isAdmixture && (
                <div className="mt-4 rounded-md border border-line p-3" data-testid="wr-entry">
                  <h4 className="mb-1 text-sm font-medium text-heading">
                    {t('materials.field.water_reduction_table')}
                  </h4>
                  <p className="mb-2 text-xs text-muted">{t('materials.entry.wrHint')}</p>
                  {table.map((r, i) => (
                    <div key={i} className="mb-2 flex items-center gap-2">
                      <Input
                        aria-label={t('materials.entry.wrDosage')}
                        dir="ltr"
                        inputMode="decimal"
                        value={r.dosage_pct}
                        onChange={(e) =>
                          setTable((s) =>
                            s.map((x, j) => (j === i ? { ...x, dosage_pct: e.target.value } : x)),
                          )
                        }
                      />
                      <Input
                        aria-label={t('materials.entry.wrReduction')}
                        dir="ltr"
                        inputMode="decimal"
                        value={r.water_reduction_pct}
                        onChange={(e) =>
                          setTable((s) =>
                            s.map((x, j) =>
                              j === i ? { ...x, water_reduction_pct: e.target.value } : x,
                            ),
                          )
                        }
                      />
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={t('materials.entry.wrRemove')}
                        onClick={() => setTable((s) => s.filter((_, j) => j !== i))}
                      >
                        <Trash2 className="size-4" aria-hidden />
                      </Button>
                    </div>
                  ))}
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() =>
                      setTable((s) => [...s, { dosage_pct: '', water_reduction_pct: '' }])
                    }
                  >
                    <Plus className="size-4" aria-hidden />
                    {t('materials.entry.wrAdd')}
                  </Button>
                  {wrErrors.length > 0 && (
                    <ul role="alert" className="mt-2 list-disc ps-5 text-xs text-fail-text">
                      {wrErrors.map((e) => (
                        <li key={e.path + e.message}>{e.message}</li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </section>
          ),
        )}

        {warnings.length > 0 && (
          <ul
            className="mb-4 list-disc rounded-md bg-warn-bg p-3 ps-8 text-sm text-warn-text"
            data-testid="sanity-warnings"
          >
            {warnings.map((w) => (
              <li key={w.field}>
                {t('materials.entry.sanity', {
                  field: t(`materials.field.${w.field}`),
                  value: f.number(w.value),
                  min: w.range.min !== undefined ? f.number(w.range.min) : '–',
                  max: w.range.max !== undefined ? f.number(w.range.max) : '–',
                })}
              </li>
            ))}
          </ul>
        )}

        <section
          className="mb-5 rounded-md border border-line p-3"
          aria-label={t('materials.entry.sourceTitle')}
        >
          <h3 className="mb-1 text-sm font-semibold text-heading">
            {t('materials.entry.sourceTitle')}
          </h3>
          <p className="mb-3 text-xs text-muted">{t('materials.entry.sourceHint')}</p>
          <div
            role="radiogroup"
            aria-label={t('materials.entry.sourceTitle')}
            className="flex flex-col gap-2"
          >
            {SOURCES.map((s) => (
              <label key={s} className="flex items-start gap-2 text-sm">
                <input
                  type="radio"
                  name="source"
                  value={s}
                  checked={source === s}
                  onChange={() => setSource(s)}
                  disabled={upgrade && s === 'user_declared'}
                  className="mt-1 size-4 accent-[var(--color-primary)]"
                  data-testid={`source-${s}`}
                />
                <span>
                  <span className="font-medium">{t(`materials.source.${s}`)}</span>
                  <span className="block text-xs text-muted">
                    {t(`materials.entry.sourceDesc.${s}`)}
                  </span>
                </span>
              </label>
            ))}
          </div>
          <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1">
              <Label htmlFor="tested-at">{t('materials.entry.testedAt')}</Label>
              <Input
                id="tested-at"
                type="date"
                dir="ltr"
                max={today()}
                value={testedAt}
                onChange={(e) => setTestedAt(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="lab-ref">{t('materials.entry.labRef')}</Label>
              <Input
                id="lab-ref"
                dir="ltr"
                value={labRef}
                onChange={(e) => setLabRef(e.target.value)}
              />
            </div>
          </div>
          <div className="mt-3 flex flex-col gap-1">
            <Label htmlFor="attach">
              {needsFile
                ? t('materials.entry.attachRequired')
                : t('materials.entry.attachOptional')}
            </Label>
            <input
              ref={fileInput}
              id="attach"
              type="file"
              accept="application/pdf,image/png,image/jpeg"
              data-testid="attach-input"
              className="text-sm file:me-3 file:rounded-md file:border file:border-line file:bg-surface file:px-3 file:py-1.5 file:text-sm"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
            <p className="text-xs text-muted">{t('materials.entry.attachHint')}</p>
          </div>
          {needsReason && (
            <div className="mt-3 flex flex-col gap-1">
              <Label htmlFor="reason">{t('materials.entry.reason')}</Label>
              <Textarea
                id="reason"
                data-testid="declared-reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder={t('materials.entry.reasonPlaceholder')}
              />
            </div>
          )}
        </section>

        {serverError && (
          <p role="alert" className="mb-3 text-sm text-fail-text" data-testid="entry-error">
            {serverError}
          </p>
        )}
        {!canCreate && isNew && (
          <p className="mb-3 text-sm text-muted">{t('materials.entry.noCreate')}</p>
        )}
        <div className="sticky bottom-0 -mx-4 flex justify-end gap-2 border-t border-line bg-surface px-4 py-3">
          <Button variant="secondary" onClick={onClose}>
            {t('rules.cancel')}
          </Button>
          <Button
            onClick={() => save.mutate()}
            disabled={blocked || save.isPending || (isNew && !canCreate)}
            data-testid="entry-submit"
          >
            {t('materials.entry.save')}
          </Button>
        </div>
      </SheetContent>
    </Dialog>
  );
}
