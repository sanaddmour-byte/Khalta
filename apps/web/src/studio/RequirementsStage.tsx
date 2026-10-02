import {
  Button,
  Input,
  Label,
  Ltr,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
} from '@khalta/ui';
import { Plus, Trash2, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { AdHocMaterial, Mode, Objective, PoolMaterial, Preflight } from './api';
import { AIR_ENTRAINED, EXPOSURE } from './characteristics';

export interface ReqState {
  plantId: string;
  mode: Mode;
  fc: string;
  basis: 'cylinder' | 'cube' | 'b_grade';
  exposure: Record<'F' | 'S' | 'W' | 'C', string>;
  s3Option: '1' | '2';
  slump: string;
  nmas: string;
  pumpable: boolean;
}
export const DEFAULT_REQ: ReqState = {
  plantId: '',
  mode: 'BOTH',
  fc: '30',
  basis: 'cylinder',
  exposure: { F: 'F0', S: 'S0', W: 'W0', C: 'C1' },
  s3Option: '1',
  slump: '100',
  nmas: '19',
  pumpable: false,
};

export const exposureList = (e: ReqState['exposure']) => [e.F, e.S, e.W, e.C];
export const NMAS_OPTIONS = ['9.5', '12.5', '19', '25', '37.5'];

export function RequirementsForm({
  req,
  set,
  plants,
  objective,
  setObjective,
  disabled,
}: {
  req: ReqState;
  set: (p: Partial<ReqState>) => void;
  plants: { id: string; label: string }[];
  objective: Objective;
  setObjective: (o: Objective) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const airEntrained = exposureList(req.exposure).some((c) => AIR_ENTRAINED.includes(c));
  return (
    <div className="flex flex-col gap-6" data-testid="requirements-form">
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        <div className="flex flex-col gap-1">
          <Label htmlFor="rq-plant">{t('studio.req.plant')}</Label>
          <Select
            value={req.plantId}
            onValueChange={(v) => set({ plantId: v })}
            disabled={disabled}
          >
            <SelectTrigger id="rq-plant" data-testid="req-plant">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {plants.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="rq-mode">{t('studio.req.mode')}</Label>
          <Select
            value={req.mode}
            onValueChange={(v) => set({ mode: v as Mode })}
            disabled={disabled}
          >
            <SelectTrigger id="rq-mode" data-testid="req-mode">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="BOTH">{t('evaluation.options.both')}</SelectItem>
              <SelectItem value="ACI">{t('evaluation.options.aci')}</SelectItem>
              <SelectItem value="JS">{t('evaluation.options.js')}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="rq-fc">{t('studio.req.strength')}</Label>
          <div className="flex gap-2">
            <Input
              id="rq-fc"
              inputMode="decimal"
              value={req.fc}
              onChange={(e) => set({ fc: e.target.value })}
              className="w-24"
              data-testid="req-fc"
              dir="ltr"
              disabled={disabled}
            />
            <Select
              value={req.basis}
              onValueChange={(v) => set({ basis: v as ReqState['basis'] })}
              disabled={disabled}
            >
              <SelectTrigger aria-label={t('studio.req.basisLabel')} data-testid="req-basis">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="cylinder">{t('studio.req.basis.cylinder')}</SelectItem>
                <SelectItem value="cube">{t('studio.req.basis.cube')}</SelectItem>
                <SelectItem value="b_grade">{t('studio.req.basis.b_grade')}</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="rq-slump">{t('studio.req.slump')}</Label>
          <Input
            id="rq-slump"
            inputMode="numeric"
            value={req.slump}
            onChange={(e) => set({ slump: e.target.value })}
            data-testid="req-slump"
            dir="ltr"
            disabled={disabled}
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="rq-nmas">{t('studio.req.nmas')}</Label>
          <Select value={req.nmas} onValueChange={(v) => set({ nmas: v })} disabled={disabled}>
            <SelectTrigger id="rq-nmas" data-testid="req-nmas">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {NMAS_OPTIONS.map((n) => (
                <SelectItem key={n} value={n}>
                  {`${n} mm`}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-center gap-3 pt-6">
          <Switch
            id="rq-pump"
            checked={req.pumpable}
            onCheckedChange={(v) => set({ pumpable: v })}
            data-testid="req-pumpable"
            disabled={disabled}
          />
          <Label htmlFor="rq-pump">{t('studio.req.pumpable')}</Label>
        </div>
      </div>

      <fieldset className="flex flex-col gap-3" data-testid="exposure-picker">
        <legend className="text-sm font-semibold">{t('studio.exposure.title')}</legend>
        <p className="text-sm text-muted">{t('studio.exposure.hint')}</p>
        {(['F', 'S', 'W', 'C'] as const).map((group) => (
          <div
            key={group}
            role="radiogroup"
            aria-label={t(`studio.exposure.group.${group}`)}
            className="flex flex-col gap-1"
          >
            <p className="text-xs font-medium text-muted">{t(`studio.exposure.group.${group}`)}</p>
            <div className="flex flex-wrap gap-2">
              {EXPOSURE[group].map((cls) => {
                const on = req.exposure[group] === cls;
                return (
                  <button
                    key={cls}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    disabled={disabled}
                    onClick={() => set({ exposure: { ...req.exposure, [group]: cls } })}
                    data-testid={`exposure-${cls}`}
                    className={`flex w-44 flex-col items-start gap-0.5 rounded-md border p-2 text-start text-sm focus-visible:outline-2 focus-visible:outline-primary ${on ? 'border-primary bg-primary-tint' : 'border-line'}`}
                  >
                    <span className="font-medium">
                      <Ltr mono>{cls}</Ltr>
                    </span>
                    <span className="text-xs text-muted">{t(`studio.exposure.${cls}`)}</span>
                  </button>
                );
              })}
            </div>
          </div>
        ))}
        {req.exposure.S === 'S3' && (
          <div className="flex flex-col gap-1">
            <Label htmlFor="rq-s3">{t('evaluation.options.s3')}</Label>
            <Select value={req.s3Option} onValueChange={(v) => set({ s3Option: v as '1' | '2' })}>
              <SelectTrigger id="rq-s3" className="w-48">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="1">{t('evaluation.options.s3Opt1')}</SelectItem>
                <SelectItem value="2">{t('evaluation.options.s3Opt2')}</SelectItem>
              </SelectContent>
            </Select>
          </div>
        )}
        {airEntrained && (
          <p
            role="alert"
            className="rounded-md border border-warn bg-warn-bg p-2 text-sm text-warn-text"
            data-testid="air-entrained-note"
          >
            {t('studio.exposure.airEntrained')}
          </p>
        )}
      </fieldset>

      <div className="flex flex-col gap-1">
        <Label htmlFor="rq-objective">{t('studio.req.objectiveLabel')}</Label>
        <Select
          value={objective}
          onValueChange={(v) => setObjective(v as Objective)}
          disabled={disabled}
        >
          <SelectTrigger id="rq-objective" className="w-64" data-testid="req-objective">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="cheapest">{t('studio.req.objective.cheapest')}</SelectItem>
            <SelectItem value="closest_to_targets">{t('studio.req.objective.closest')}</SelectItem>
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}

/** Material pool: chips by category; unusable ones say why; what-if materials are marked and removable. */
export function PoolChips({
  pool,
  excluded,
  toggle,
  adHoc,
  removeAdHoc,
  nameOf,
  onAdd,
}: {
  pool: PoolMaterial[];
  excluded: string[];
  toggle: (id: string) => void;
  adHoc: AdHocMaterial[];
  removeAdHoc: (i: number) => void;
  nameOf: (m: PoolMaterial) => string;
  onAdd: () => void;
}) {
  const { t } = useTranslation();
  const cats = ['cement', 'scm', 'fine_agg', 'coarse_agg', 'admixture', 'water'];
  return (
    <section className="flex flex-col gap-3" aria-labelledby="pool-title" data-testid="pool">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id="pool-title" className="text-sm font-semibold">
          {t('studio.pool.title')}
        </h3>
        <Button variant="secondary" size="sm" onClick={onAdd} data-testid="adhoc-open">
          <Plus className="size-4" aria-hidden />
          {t('studio.pool.addAdHoc')}
        </Button>
      </div>
      <p className="text-xs text-muted">{t('studio.pool.hint')}</p>
      {cats.map((cat) => {
        const items = pool.filter((m) => m.category === cat);
        const extra = adHoc.map((a, i) => ({ a, i })).filter(({ a }) => a.category === cat);
        if (items.length === 0 && extra.length === 0) return null;
        return (
          <div key={cat} className="flex flex-col gap-1">
            <p className="text-xs font-medium text-muted">{t(`studio.pool.cat.${cat}`)}</p>
            <ul className="flex flex-wrap gap-2">
              {items.map((m) => {
                const off = !m.usable || excluded.includes(m.id);
                return (
                  <li key={m.id}>
                    <button
                      type="button"
                      onClick={() => m.usable && toggle(m.id)}
                      aria-pressed={!off}
                      aria-disabled={!m.usable}
                      title={m.reason ?? undefined}
                      data-testid="pool-chip"
                      data-usable={m.usable}
                      data-excluded={excluded.includes(m.id)}
                      className={`rounded-md border px-2 py-1 text-sm focus-visible:outline-2 focus-visible:outline-primary ${off ? 'border-line text-muted line-through' : 'border-primary bg-primary-tint'}`}
                    >
                      {nameOf(m)}
                    </button>
                    {!m.usable && m.reason && (
                      <span className="block max-w-56 text-xs text-muted">{m.reason}</span>
                    )}
                  </li>
                );
              })}
              {extra.map(({ a, i }) => (
                <li key={`adhoc-${i}`}>
                  <span
                    className="inline-flex items-center gap-1 rounded-md border border-warn bg-warn-bg px-2 py-1 text-sm text-warn-text"
                    data-testid="adhoc-chip"
                  >
                    {a.market_name_en}
                    <span className="text-xs">{t('studio.pool.whatIf')}</span>
                    <button
                      type="button"
                      onClick={() => removeAdHoc(i)}
                      aria-label={t('studio.pool.removeAdHoc', { name: a.market_name_en })}
                    >
                      <X className="size-3.5" aria-hidden />
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </section>
  );
}

export interface MixLine {
  materialId: string;
  kg: string;
}

/** Evaluate path: the proportions are typed here. Nothing is stored until "Save as draft". */
export function MixGrid({
  lines,
  setLines,
  pool,
  nameOf,
}: {
  lines: MixLine[];
  setLines: (l: MixLine[]) => void;
  pool: PoolMaterial[];
  nameOf: (m: PoolMaterial) => string;
}) {
  const { t } = useTranslation();
  const usable = pool.filter((m) => m.usable || m.hasTest);
  const upd = (i: number, p: Partial<MixLine>) =>
    setLines(lines.map((l, j) => (j === i ? { ...l, ...p } : l)));
  return (
    <section className="flex flex-col gap-2" aria-labelledby="mix-title" data-testid="mix-grid">
      <h3 id="mix-title" className="text-sm font-semibold">
        {t('studio.mix.title')}
      </h3>
      <p className="text-xs text-muted">{t('studio.mix.hint')}</p>
      {lines.map((l, i) => (
        <div key={i} className="flex flex-wrap items-center gap-2" data-testid="mix-line">
          <Select value={l.materialId} onValueChange={(v) => upd(i, { materialId: v })}>
            <SelectTrigger
              className="w-64"
              aria-label={t('studio.mix.material')}
              data-testid={`mix-material-${i}`}
            >
              <SelectValue placeholder={t('studio.mix.material')} />
            </SelectTrigger>
            <SelectContent>
              {usable.map((m) => (
                <SelectItem key={m.id} value={m.id}>
                  {nameOf(m)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Input
            inputMode="decimal"
            className="w-28"
            value={l.kg}
            onChange={(e) => upd(i, { kg: e.target.value })}
            aria-label={t('studio.mix.kg')}
            data-testid={`mix-kg-${i}`}
            dir="ltr"
          />
          <span className="text-xs text-muted">{`${'kg'}/m³`}</span>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setLines(lines.filter((_, j) => j !== i))}
            aria-label={t('studio.mix.remove')}
          >
            <Trash2 className="size-4" aria-hidden />
          </Button>
        </div>
      ))}
      <div>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => setLines([...lines, { materialId: '', kg: '' }])}
          data-testid="mix-add"
        >
          <Plus className="size-4" aria-hidden />
          {t('studio.mix.add')}
        </Button>
      </div>
    </section>
  );
}

export const preflightBlockedByRequest = (p: Preflight | undefined) =>
  !!p && p.blockers.some((b) => b.code === 'not_supported' || b.code === 'request_infeasible');
