import {
  Button,
  Checkbox,
  EvidenceChip,
  Label,
  Ltr,
  Table,
  Td,
  Th,
  type EvidenceStatus,
} from '@khalta/ui';
import { Info } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useFormat } from '../lib/format';
import type { Candidate } from './api';

export const fig = (c: Candidate, key: string): number | null => {
  const v = c.report.figures[key];
  return typeof v === 'number' ? v : null;
};

/** A bar for one governing constraint: how much room is left. Text first, the bar is decoration. */
function MarginBar({
  label,
  value,
  scale,
  unit,
}: {
  label: string;
  value: number;
  scale: number;
  unit?: string;
}) {
  const f = useFormat();
  const pct = Math.max(0, Math.min(100, (value / scale) * 100));
  return (
    <div className="flex flex-col gap-0.5 text-xs" data-testid="margin-bar">
      <div className="flex justify-between gap-2">
        <span className="text-muted">{label}</span>
        <Ltr>
          {f.number(value, { maximumFractionDigits: 3 })}
          {unit ? ` ${unit}` : ''}
        </Ltr>
      </div>
      <div className="h-1.5 rounded-full bg-line" aria-hidden>
        <div className="h-1.5 rounded-full bg-primary" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

export function CandidateCard({
  c,
  best,
  nameOf,
  pinned,
  canPin,
  onPin,
  onOpen,
  canCost,
}: {
  c: Candidate;
  best: number | null;
  nameOf: (id: string) => string;
  pinned: boolean;
  canPin: boolean;
  onPin: (on: boolean) => void;
  onOpen: () => void;
  canCost: boolean;
}) {
  const { t } = useTranslation();
  const f = useFormat();
  const cost = c.costJodPerM3 === null ? null : Number(c.costJodPerM3);
  const met = c.characteristics.filter((r) => r.status === 'met').length;
  const wcm = fig(c, 'ratio.wcm');
  const binder = fig(c, 'mass.binder');
  const cfg = c.configuration;
  return (
    <article
      className="flex flex-col gap-3 rounded-lg border border-line p-4"
      data-testid="candidate-card"
      data-rank={c.rank}
      aria-label={t('studio.cand.aria', { rank: c.rank })}
    >
      <header className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold text-muted">{t('studio.cand.rank', { n: c.rank })}</p>
          {canCost && cost !== null && (
            <p
              className="text-2xl font-semibold text-heading tabular-nums"
              data-testid="candidate-cost"
            >
              <Ltr>{f.number(cost, { minimumFractionDigits: 3, maximumFractionDigits: 3 })}</Ltr>
              <span className="ms-1 text-sm font-normal text-muted">{t('studio.cand.perM3')}</span>
            </p>
          )}
          {canCost && cost !== null && best !== null && c.rank > 1 && (
            <p className="text-xs text-muted">
              {t('studio.cand.delta', {
                n: f.number(cost - best, {
                  minimumFractionDigits: 3,
                  maximumFractionDigits: 3,
                  signDisplay: 'always',
                }),
              })}
            </p>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Checkbox
            id={`pin-${c.id}`}
            checked={pinned}
            disabled={!pinned && !canPin}
            onCheckedChange={(v) => onPin(v === true)}
            data-testid={`pin-${c.rank}`}
          />
          <Label htmlFor={`pin-${c.id}`}>{t('studio.cand.pin')}</Label>
        </div>
      </header>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
        <dt className="text-muted">{t('studio.cand.binder')}</dt>
        <dd>
          <Ltr>{`${binder === null ? '–' : f.number(binder, { maximumFractionDigits: 0 })} kg/m³`}</Ltr>
        </dd>
        <dt className="text-muted">{t('studio.cand.wcm')}</dt>
        <dd>
          <Ltr>{wcm === null ? '–' : f.number(wcm, { maximumFractionDigits: 3 })}</Ltr>
        </dd>
        <dt className="text-muted">{t('studio.cand.cement')}</dt>
        <dd>{nameOf(cfg.cementId)}</dd>
        <dt className="text-muted">{t('studio.cand.scm')}</dt>
        <dd>
          {cfg.scmId ? `${nameOf(cfg.scmId)} · ${f.number(cfg.scmPct)}%` : t('studio.cand.none')}
        </dd>
        <dt className="text-muted">{t('studio.cand.admixture')}</dt>
        <dd>
          {cfg.admixtureId
            ? `${nameOf(cfg.admixtureId)} · ${f.number(cfg.dosagePct)}%`
            : t('studio.cand.none')}
        </dd>
      </dl>
      <div className="grid gap-2" aria-label={t('studio.cand.margins')}>
        <MarginBar label={t('studio.cand.m.wcm')} value={c.margins.wcmHeadroom} scale={0.1} />
        <MarginBar label={t('studio.cand.m.cf')} value={c.margins.cfMargin} scale={15} />
        <MarginBar label={t('studio.cand.m.wf')} value={c.margins.wfMargin} scale={10} />
        <MarginBar
          label={t('studio.cand.m.fines')}
          value={c.margins.finesMargin}
          scale={3}
          unit="%"
        />
        <MarginBar
          label={t('studio.cand.m.grading')}
          value={c.margins.gradingMarginPts}
          scale={8}
          unit={t('studio.cand.pts')}
        />
      </div>
      {c.characteristics.length > 0 && (
        <p className="text-sm" data-testid="chars-met">
          {t('studio.cand.charsMet', { met, total: c.characteristics.length })}
        </p>
      )}
      <div className="flex flex-wrap gap-1.5" data-testid="candidate-evidence">
        {c.evidence.map((e) => (
          <EvidenceChip key={e} status={e as EvidenceStatus} />
        ))}
      </div>
      {c.notes.map((n) => (
        <p key={n.code} className="flex gap-2 text-xs text-warn-text" data-testid="candidate-note">
          <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          {t(`studio.note.${n.code}`, { defaultValue: n.detail })}
        </p>
      ))}
      <Button variant="secondary" onClick={onOpen} data-testid={`inspect-${c.rank}`}>
        {t('studio.cand.inspect')}
      </Button>
    </article>
  );
}

/** Up to four pinned candidates side by side; rows that differ are marked. */
export function CompareTable({
  cands,
  nameOf,
  canCost,
}: {
  cands: Candidate[];
  nameOf: (id: string) => string;
  canCost: boolean;
}) {
  const { t } = useTranslation();
  const f = useFormat();
  const num = (v: number | null, d = 3) =>
    v === null ? '–' : f.number(v, { maximumFractionDigits: d });
  const ids = [...new Set(cands.flatMap((c) => c.lines.map((l) => l.materialId)))];
  type Row = { key: string; label: string; vals: string[] };
  const rows: Row[] = [
    ...(canCost
      ? [
          {
            key: 'cost',
            label: t('studio.cmp.cost'),
            vals: cands.map((c) => (c.costJodPerM3 === null ? '–' : num(Number(c.costJodPerM3)))),
          },
        ]
      : []),
    {
      key: 'binder',
      label: t('studio.cand.binder'),
      vals: cands.map((c) => num(fig(c, 'mass.binder'), 0)),
    },
    { key: 'wcm', label: t('studio.cand.wcm'), vals: cands.map((c) => num(fig(c, 'ratio.wcm'))) },
    {
      key: 'water',
      label: t('studio.cmp.water'),
      vals: cands.map((c) => num(fig(c, 'mass.water'), 0)),
    },
    {
      key: 'paste',
      label: t('studio.cmp.paste'),
      vals: cands.map((c) => num(fig(c, 'agg.paste_l'), 0)),
    },
    {
      key: 'sand',
      label: t('studio.cmp.sand'),
      vals: cands.map((c) => num(fig(c, 'agg.sand_ratio_mass_pct'), 1)),
    },
    {
      key: 'density',
      label: t('studio.cmp.density'),
      vals: cands.map((c) => num(fig(c, 'mass.fresh_density'), 0)),
    },
    {
      key: 'cf',
      label: t('studio.cmp.cf'),
      vals: cands.map((c) => num(c.guardrails.coarsenessFactor, 1)),
    },
    {
      key: 'wf',
      label: t('studio.cmp.wf'),
      vals: cands.map((c) => num(c.guardrails.workabilityFactorAdjusted, 1)),
    },
    ...ids.map((id) => ({
      key: `m-${id}`,
      label: nameOf(id),
      vals: cands.map((c) => {
        const l = c.lines.find((x) => x.materialId === id);
        return l ? num(Number(l.kgPerM3), 2) : '–';
      }),
    })),
  ];
  return (
    <div className="overflow-x-auto" data-testid="compare-table">
      <Table>
        <caption className="sr-only">{t('studio.cmp.title')}</caption>
        <thead>
          <tr>
            <Th>{t('studio.cmp.row')}</Th>
            {cands.map((c) => (
              <Th key={c.id}>{t('studio.cand.rank', { n: c.rank })}</Th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const differs = new Set(r.vals).size > 1;
            return (
              <tr key={r.key} className="border-t border-line" data-differs={differs}>
                <Td className={differs ? 'font-medium text-heading' : 'text-muted'}>{r.label}</Td>
                {r.vals.map((v, i) => (
                  <Td key={i} className={differs ? 'bg-warn-bg/40' : ''}>
                    <Ltr>{v}</Ltr>
                  </Td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </Table>
    </div>
  );
}
