import {
  Input,
  Label,
  Ltr,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@khalta/ui';
import { useTranslation } from 'react-i18next';
import {
  CHAR_DEFS,
  SECTIONS,
  SIEVES,
  emptyChar,
  rowId,
  type CharDef,
  type CharMap,
  type CharMode,
  type CharState,
} from './characteristics';
import type { Bound, PoolMaterial, Rejected } from './api';
import { describeSpec } from './characteristics';

interface Props {
  pool: PoolMaterial[];
  map: CharMap;
  onChange: (next: CharMap) => void;
  bounds: Bound[];
  rejected: Rejected[];
  nameOf: (m: PoolMaterial) => string;
  disabled?: boolean;
  /** Values a selected profile supplies, by row id, with a readable origin label ("C30 pump v3"). */
  profileRows?: Record<string, { label: string; spec: Record<string, unknown> }>;
}

const fmt = (v: unknown) =>
  typeof v === 'number' ? String(v) : Array.isArray(v) ? v.join(', ') : String(v);

/** The characteristics the engineer may set (07 §6), grouped; each value shows where it comes from. */
export function CharacteristicsPanel({
  pool,
  map,
  onChange,
  bounds,
  rejected,
  nameOf,
  disabled,
  profileRows,
}: Props) {
  const { t } = useTranslation();
  const usable = pool.filter((m) => m.usable);
  const of = (cat: string[]) => usable.filter((m) => cat.includes(m.category));
  const set = (id: string, patch: Partial<CharState>) =>
    onChange({ ...map, [id]: { ...(map[id] ?? emptyChar()), ...patch } });

  const rows = (def: CharDef): { id: string; label: string; sub?: string }[] => {
    if (def.keyed === 'aggregate')
      return of(['fine_agg', 'coarse_agg']).map((m) => ({
        id: rowId(def.key, m.id),
        label: nameOf(m),
        sub: m.id,
      }));
    if (def.keyed === 'sieve')
      return SIEVES.map((s) => ({ id: rowId(def.key, s), label: `${s} mm`, sub: s }));
    return [{ id: def.key, label: '' }];
  };

  return (
    <div className="flex flex-col gap-6" data-testid="characteristics-panel">
      {SECTIONS.map((section) => (
        <section key={section} aria-labelledby={`chars-${section}`} className="flex flex-col gap-2">
          <h3
            id={`chars-${section}`}
            className="text-sm font-semibold uppercase tracking-wide text-muted"
          >
            {t(`studio.chars.section.${section}`)}
          </h3>
          <div className="flex flex-col divide-y divide-line rounded-md border border-line">
            {CHAR_DEFS.filter((d) => d.section === section).flatMap((def) =>
              rows(def).map((row) => (
                <CharRow
                  key={row.id}
                  def={def}
                  id={row.id}
                  label={row.label}
                  state={map[row.id] ?? emptyChar()}
                  set={(p) => set(row.id, p)}
                  products={
                    def.key === 'scm'
                      ? of(['scm'])
                      : def.key === 'admixture'
                        ? of(['admixture'])
                        : []
                  }
                  nameOf={nameOf}
                  bound={bounds.find((b) => b.requirement === def.bound)}
                  rejected={rejected.filter((r) => r.key === row.id)}
                  disabled={disabled}
                  profile={profileRows?.[row.id]}
                />
              )),
            )}
          </div>
        </section>
      ))}
    </div>
  );
}

function CharRow({
  def,
  id,
  label,
  state,
  set,
  products,
  nameOf,
  bound,
  rejected,
  disabled,
  profile,
}: {
  def: CharDef;
  id: string;
  label: string;
  state: CharState;
  set: (p: Partial<CharState>) => void;
  products: PoolMaterial[];
  nameOf: (m: PoolMaterial) => string;
  bound: Bound | undefined;
  rejected: Rejected[];
  disabled: boolean | undefined;
  profile: { label: string; spec: Record<string, unknown> } | undefined;
}) {
  const { t } = useTranslation();
  const name = t(`studio.chars.${def.key}`);
  const hasProduct = def.key === 'scm' || def.key === 'admixture';
  const unit =
    def.key === 'wcm' || def.key === 'fm_combined' || def.key.startsWith('shilstone')
      ? ''
      : def.unit;
  const numeric = (field: 'value' | 'min' | 'max', testid: string, aria: string) => (
    <Input
      inputMode="decimal"
      className="w-28"
      value={state[field]}
      onChange={(e) => set({ [field]: e.target.value })}
      aria-label={aria}
      data-testid={`${testid}-${id}`}
      disabled={disabled}
      dir="ltr"
    />
  );
  return (
    <div className="flex flex-col gap-2 p-3" data-testid={`char-row-${id}`}>
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-44 flex-1">
          <Label htmlFor={`mode-${id}`}>
            {name}
            {label && <span className="ms-2 font-normal text-muted">{label}</span>}
          </Label>
          {bound && bound.value !== null && (
            <p className="text-xs text-muted" data-testid={`char-bound-${id}`}>
              {t('studio.chars.bound', {
                value: fmt(bound.value),
                source: bound.source ?? '',
                clause: bound.clause ?? '',
              })}
            </p>
          )}
        </div>
        <Select
          value={state.mode}
          onValueChange={(v) => set({ mode: v as CharMode })}
          disabled={disabled}
        >
          <SelectTrigger id={`mode-${id}`} className="w-32" data-testid={`char-mode-${id}`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {def.modes.map((m) => (
              <SelectItem key={m} value={m}>
                {t(`studio.chars.mode.${m}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {state.mode !== 'auto' && (
          <div className="flex flex-wrap items-center gap-2">
            {hasProduct && (
              <Select
                value={state.product}
                onValueChange={(v) => set({ product: v })}
                disabled={disabled}
              >
                <SelectTrigger
                  className="w-44"
                  aria-label={t('studio.chars.product')}
                  data-testid={`char-product-${id}`}
                >
                  <SelectValue placeholder={t('studio.chars.product')} />
                </SelectTrigger>
                <SelectContent>
                  {products.map((m) => (
                    <SelectItem key={m.id} value={m.id}>
                      {nameOf(m)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            {def.key === 'admixture' ? (
              <Input
                inputMode="numeric"
                className="w-24"
                value={state.level}
                onChange={(e) => set({ level: e.target.value })}
                aria-label={t('studio.chars.level')}
                data-testid={`char-level-${id}`}
                disabled={disabled}
                dir="ltr"
              />
            ) : state.mode === 'range' ? (
              <>
                {numeric('min', 'char-min', t('studio.chars.min'))}
                {numeric('max', 'char-max', t('studio.chars.max'))}
              </>
            ) : (
              numeric(
                'value',
                'char-value',
                t(state.mode === 'target' ? 'studio.chars.target' : 'studio.chars.value'),
              )
            )}
            {unit && <Ltr className="text-xs text-muted">{unit}</Ltr>}
          </div>
        )}
      </div>
      {state.mode !== 'auto' ? (
        <p className="text-xs text-muted" data-testid={`char-origin-${id}`} data-origin="request">
          {t('studio.chars.origin.request')}
          {profile && ` · ${t('studio.chars.origin.overrides', { label: profile.label })}`}
        </p>
      ) : (
        profile && (
          <p className="text-xs text-muted" data-testid={`char-origin-${id}`} data-origin="profile">
            {t('studio.chars.origin.profile', {
              label: profile.label,
              value: describeSpec(profile.spec),
            })}
          </p>
        )
      )}
      {rejected.map((r, i) => (
        <p
          key={i}
          role="alert"
          className="rounded-md border border-fail bg-fail-bg px-2 py-1 text-xs text-fail-text"
          data-testid={`char-rejected-${id}`}
        >
          {t('studio.chars.rejected', { value: fmt(r.proposed), allowed: fmt(r.allowed) })}
          {r.rule && (
            <>
              {' '}
              <Ltr>
                {r.source ? `${r.source} · ` : ''}
                {r.rule}
                {r.clause ? ` · ${r.clause}` : ''}
              </Ltr>
            </>
          )}
        </p>
      ))}
    </div>
  );
}
