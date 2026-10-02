import {
  Button,
  Checkbox,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  Label,
  Ltr,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Table,
  Td,
  Th,
} from '@khalta/ui';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError, type Plant } from '../lib/api';
import { useFormat } from '../lib/format';
import { usePrefs } from '../lib/prefs';
import { materialsQuery } from '../materials/api';
import { comparePlants, type CompareResult, type RequestBody } from './api';

const NONE = '__none__';

/** Material ids a request pins (so a mapping to other plants is needed). Everything else maps by itself. */
export function referencedMaterials(
  body: Pick<RequestBody, 'materials' | 'characteristics'>,
): string[] {
  const ids = new Set<string>([
    ...(body.materials?.include ?? []),
    ...(body.materials?.exclude ?? []),
  ]);
  const c = (body.characteristics ?? {}) as Record<string, unknown>;
  for (const k of ['agg_kg', 'agg_share_pct'])
    for (const id of Object.keys((c[k] as Record<string, unknown>) ?? {})) ids.add(id);
  for (const k of ['scm', 'admixture']) {
    const p = (c[k] as { product?: string } | undefined)?.product;
    if (p) ids.add(p);
  }
  return [...ids];
}

/**
 * Compare plants (F-020): the same request at every chosen plant. The material mapping is shown and must be
 * confirmed; everything is theoretical and trial-only. Cost appears only for roles that may see it.
 */
export function ComparePlantsDialog({
  open,
  onOpenChange,
  body,
  plants,
  currentPlantId,
  canCost,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  body: Omit<RequestBody, 'plantId'>;
  plants: Plant[];
  currentPlantId: string;
  canCost: boolean;
}) {
  const { t } = useTranslation();
  const { lang } = usePrefs();
  const f = useFormat();
  const mats = useQuery({ ...materialsQuery(), enabled: open });
  const [chosen, setChosen] = useState<string[]>([]);
  const [mapping, setMapping] = useState<Record<string, Record<string, string>>>({});
  const [confirmed, setConfirmed] = useState(false);
  const refs = useMemo(() => referencedMaterials(body), [body]);
  const all = useMemo(() => mats.data ?? [], [mats.data]);
  const home = (id: string) => all.find((m) => m.id === id);
  const name = (p: Plant) => (lang === 'ar' ? p.nameAr : p.nameEn);
  const mname = (m: { marketNameEn: string; marketNameAr: string | null }) =>
    lang === 'ar' ? (m.marketNameAr ?? m.marketNameEn) : m.marketNameEn;

  /** Default counterpart: same category and the same market name at the other plant. */
  const defaultFor = (plantId: string, refId: string) => {
    const h = home(refId);
    if (!h) return NONE;
    const hit = all.find(
      (m) =>
        m.plantId === plantId && m.category === h.category && m.marketNameEn === h.marketNameEn,
    );
    return hit?.id ?? NONE;
  };
  const valueOf = (plantId: string, refId: string) =>
    mapping[plantId]?.[refId] ?? defaultFor(plantId, refId);
  const toggle = (id: string) => {
    setConfirmed(false);
    setChosen((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));
  };
  const run = useMutation({
    mutationFn: () =>
      comparePlants({
        ...body,
        plants: chosen.map((plantId) => ({
          plantId,
          mapping: Object.fromEntries(
            refs.map((r) => [r, valueOf(plantId, r) === NONE ? null : valueOf(plantId, r)]),
          ),
        })),
      }),
  });
  const results = run.data?.results ?? [];
  const best = Math.min(
    ...results.map((r) => (r.best?.costJodPerM3 ? Number(r.best.costJodPerM3) : Infinity)),
  );
  const current = results.find((r) => r.plantId === currentPlantId)?.best?.costJodPerM3;
  const plantName = (id: string) => {
    const p = plants.find((x) => x.id === id);
    return p ? name(p) : id.slice(0, 8);
  };
  const reason = (r: CompareResult) =>
    r.reason?.startsWith('no_counterpart')
      ? t('studio.compare.noCounterpart')
      : r.reason
        ? t(`studio.compare.reason.${r.reason}`, { defaultValue: r.reason })
        : t(`studio.status.${r.status}`);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent closeLabel={t('ui.close')} className="max-w-3xl" data-testid="compare-plants">
        <DialogTitle className="text-lg font-semibold text-heading">
          {t('studio.compare.title')}
        </DialogTitle>
        <DialogDescription className="text-sm text-muted">
          {t('studio.compare.hint')}
        </DialogDescription>
        <fieldset className="mt-4 flex flex-col gap-2">
          <legend className="text-sm font-medium">{t('studio.compare.plants')}</legend>
          {plants.map((p) => (
            <div key={p.id} className="flex items-center gap-2">
              <Checkbox
                id={`cp-${p.id}`}
                checked={chosen.includes(p.id)}
                onCheckedChange={() => toggle(p.id)}
                data-testid={`compare-plant-${p.code}`}
              />
              <Label htmlFor={`cp-${p.id}`}>{name(p)}</Label>
            </div>
          ))}
        </fieldset>
        {chosen.length > 0 && (
          <section className="mt-4 flex flex-col gap-2" aria-label={t('studio.compare.mapping')}>
            <h4 className="text-sm font-medium">{t('studio.compare.mapping')}</h4>
            {refs.length === 0 ? (
              <p className="text-sm text-muted" data-testid="mapping-none">
                {t('studio.compare.mappingNone')}
              </p>
            ) : (
              chosen.flatMap((pid) =>
                refs.map((r) => {
                  const h = home(r);
                  return (
                    <div key={`${pid}-${r}`} className="flex flex-wrap items-center gap-2 text-sm">
                      <span className="min-w-40">
                        {plantName(pid)} · {h ? mname(h) : r.slice(0, 8)}
                      </span>
                      <Select
                        value={valueOf(pid, r)}
                        onValueChange={(v) => {
                          setConfirmed(false);
                          setMapping((m) => ({ ...m, [pid]: { ...(m[pid] ?? {}), [r]: v } }));
                        }}
                      >
                        <SelectTrigger
                          className="w-56"
                          aria-label={t('studio.compare.counterpart')}
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value={NONE}>{t('studio.compare.noneOption')}</SelectItem>
                          {all
                            .filter((m) => m.plantId === pid && h && m.category === h.category)
                            .map((m) => (
                              <SelectItem key={m.id} value={m.id}>
                                {mname(m)}
                              </SelectItem>
                            ))}
                        </SelectContent>
                      </Select>
                    </div>
                  );
                }),
              )
            )}
            <div className="flex items-center gap-2">
              <Checkbox
                id="cp-confirm"
                checked={confirmed}
                onCheckedChange={(v) => setConfirmed(v === true)}
                data-testid="compare-confirm"
              />
              <Label htmlFor="cp-confirm">{t('studio.compare.confirm')}</Label>
            </div>
          </section>
        )}
        <div className="mt-4 flex items-center gap-3">
          <Button
            disabled={chosen.length === 0 || !confirmed || run.isPending}
            onClick={() => run.mutate()}
            data-testid="compare-run"
          >
            {run.isPending ? t('studio.compare.running') : t('studio.compare.run')}
          </Button>
          {run.error instanceof ApiError && (
            <p role="alert" className="text-sm text-fail-text">
              {run.error.message}
            </p>
          )}
        </div>
        {results.length > 0 && (
          <div className="mt-4 overflow-x-auto">
            <p className="mb-2 text-xs text-muted">{t('studio.compare.theoretical')}</p>
            <Table data-testid="compare-results">
              <caption className="sr-only">{t('studio.compare.title')}</caption>
              <thead>
                <tr>
                  <Th>{t('studio.compare.col.plant')}</Th>
                  <Th>{t('studio.compare.col.status')}</Th>
                  {canCost && <Th>{t('studio.compare.col.best')}</Th>}
                  {canCost && <Th>{t('studio.compare.col.delta')}</Th>}
                  <Th>{t('studio.compare.col.haul')}</Th>
                </tr>
              </thead>
              <tbody>
                {results.map((r) => {
                  const c = r.best?.costJodPerM3 ? Number(r.best.costJodPerM3) : null;
                  return (
                    <tr
                      key={r.plantId}
                      className="border-t border-line"
                      data-testid="compare-row"
                      data-status={r.status}
                      data-best={c !== null && c === best}
                    >
                      <Td>{plantName(r.plantId)}</Td>
                      <Td>
                        {r.status === 'candidates'
                          ? t('studio.compare.candidates', { n: r.best?.candidates ?? 0 })
                          : reason(r)}
                      </Td>
                      {canCost && (
                        <Td>
                          <Ltr>{c === null ? '–' : f.number(c, { minimumFractionDigits: 3 })}</Ltr>
                        </Td>
                      )}
                      {canCost && (
                        <Td>
                          <Ltr>
                            {c === null || current === undefined || current === null
                              ? '–'
                              : f.number(c - Number(current), {
                                  minimumFractionDigits: 3,
                                  signDisplay: 'always',
                                })}
                          </Ltr>
                        </Td>
                      )}
                      <Td className="text-muted">{t('studio.compare.haulNA')}</Td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
