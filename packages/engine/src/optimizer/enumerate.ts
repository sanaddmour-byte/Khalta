// The discrete choices of a search: cement × SCM × SCM % × admixture × dosage level × NMAS. The LP then picks
// the continuous quantities for each. Order is deterministic; above the cap the grid is coarsened and the
// truncation is reported (never silent).
import { waterReduction } from '../evaluate/baselines';
import { isNum } from '../evaluate/util';
import type { ResolvedCharacteristic } from '../characteristics/resolve';
import type { AdmixLevel, AdmixMat, CementMat, Prepared, ScmMat } from './prepare';
import type { OptimizerBlocker } from './types';

export interface ConfigSpec {
  cement: CementMat;
  scm: ScmMat | null;
  scmPct: number;
  admix: AdmixMat | null;
  level: AdmixLevel | null;
  nmas: number;
  airPct: number;
}

export const charOf = (chars: readonly ResolvedCharacteristic[], key: string) =>
  chars.find((c) => c.key === key && c.sub === null);

const sortKey = (c: ConfigSpec) =>
  [
    c.cement.id,
    c.scm?.id ?? '',
    String(c.scmPct).padStart(6, '0'),
    c.admix?.id ?? '',
    String(c.level?.dosagePct ?? 0).padStart(8, '0'),
    String(c.nmas).padStart(6, '0'),
    String(c.airPct).padStart(6, '0'),
  ].join('|');

function pctGrid(lo: number, hi: number, step: number): number[] {
  const out = new Set<number>();
  for (let p = Math.ceil(lo / step) * step; p <= hi + 1e-9; p += step)
    out.add(Math.round(p * 1e6) / 1e6);
  out.add(lo);
  out.add(hi);
  return [...out].filter((p) => p >= lo - 1e-9 && p <= hi + 1e-9).sort((a, b) => a - b);
}

export function enumerate(p: Prepared): {
  configs: ConfigSpec[];
  total: number;
  truncated: boolean;
  blockers: OptimizerBlocker[];
  notes: { code: string; detail: string }[];
} {
  const set = p.input.settings;
  const blockers: OptimizerBlocker[] = [];
  const notes: { code: string; detail: string }[] = [];
  const scmChar = charOf(p.chars, 'scm');
  const admChar = charOf(p.chars, 'admixture');
  const airChar = charOf(p.chars, 'air_pct');
  const req = p.input.base.request;

  const scmOptions = (stepMul: number): { scm: ScmMat | null; pct: number }[] => {
    const out: { scm: ScmMat | null; pct: number }[] = [];
    const step = set.scmStepPct * stepMul;
    const typeOk = (s: ScmMat) =>
      p.scmRequired === null ||
      p.scmRequired.some((a) =>
        a === 'pozzolan'
          ? s.type === 'fly_ash' || s.type === 'natural_pozzolan'
          : a === 'slag'
            ? s.type === 'ggbs'
            : false,
      );
    if (scmChar && scmChar.spec.mode !== 'auto') {
      const product = String(scmChar.spec['product']);
      const s = p.scms.find((x) => x.id === product);
      if (!s) {
        blockers.push({
          code: 'no_materials',
          subject: product,
          detail: `The requested SCM ${product} is not usable (see the excluded list)`,
        });
        return [];
      }
      const lim = p.scmLimits(s).maxPct;
      if (scmChar.spec.mode === 'fixed') return [{ scm: s, pct: scmChar.spec['pct'] as number }];
      const lo = (scmChar.spec.min as number | undefined) ?? 0;
      const hi = Math.min(
        (scmChar.spec.max as number | undefined) ?? lim ?? set.scmSearchCapPct,
        lim ?? 100,
      );
      return pctGrid(lo, hi, step).map((pct) => ({ scm: s, pct }));
    }
    if (p.scmRequired === null) out.push({ scm: null, pct: 0 });
    for (const s of p.scms) {
      if (!typeOk(s)) continue;
      const lim = p.scmLimits(s).maxPct;
      const hi = lim ?? set.scmSearchCapPct;
      for (const pct of pctGrid(step, hi, step))
        if (pct > 0 && pct <= hi) out.push({ scm: s, pct });
    }
    return out;
  };

  const admixOptions = (
    levelsMode: 'all' | 'ends',
  ): { admix: AdmixMat | null; level: AdmixLevel | null }[] => {
    if (admChar && admChar.spec.mode !== 'auto') {
      const product = String(admChar.spec['product']);
      const a = p.admixtures.find((x) => x.id === product);
      if (!a) {
        blockers.push({
          code: 'no_materials',
          subject: product,
          detail: `The requested admixture ${product} is not usable (see the excluded list)`,
        });
        return [];
      }
      if (admChar.spec.mode === 'fixed') {
        const lvl = admChar.spec['dosage_level'];
        const pct = admChar.spec['dosage_pct'];
        if (isNum(lvl)) {
          const l = a.levels[lvl - 1];
          if (!l) {
            blockers.push({
              code: 'out_of_domain',
              subject: product,
              detail: `${a.name} has no dosage level ${lvl} (it has ${a.levels.length})`,
            });
            return [];
          }
          return [{ admix: a, level: l }];
        }
        if (isNum(pct)) {
          const wr = waterReduction(a.m, pct);
          if (!wr.ok) {
            blockers.push({ code: 'out_of_domain', subject: product, detail: wr.detail });
            return [];
          }
          return [{ admix: a, level: { dosagePct: pct, waterReductionPct: wr.pct, level: 0 } }];
        }
        blockers.push({
          code: 'input_missing',
          subject: product,
          detail: 'A fixed admixture needs a dosage level or a dosage %',
        });
        return [];
      }
      const lo = (admChar.spec.min as number | undefined) ?? 0;
      const hi = (admChar.spec.max as number | undefined) ?? Infinity;
      const ls = a.levels.filter((l) => l.dosagePct >= lo - 1e-9 && l.dosagePct <= hi + 1e-9);
      if (ls.length === 0) {
        blockers.push({
          code: 'out_of_domain',
          subject: product,
          detail: `${a.name} has no tabulated dosage inside the requested range`,
        });
        return [];
      }
      return ends(ls, levelsMode).map((l) => ({ admix: a, level: l }));
    }
    const out: { admix: AdmixMat | null; level: AdmixLevel | null }[] = [
      { admix: null, level: null },
    ];
    for (const a of p.admixtures)
      for (const l of ends(a.levels, levelsMode)) out.push({ admix: a, level: l });
    return out;
  };
  const ends = (ls: AdmixLevel[], mode: 'all' | 'ends') =>
    mode === 'all' || ls.length <= 2 ? ls : [ls[0]!, ls[ls.length - 1]!];

  const airOptions = (nmas: number): number[] => {
    if (req.airPct !== null) return [req.airPct];
    const baseline = p.airByNmas.get(nmas)!;
    if (airChar?.spec.mode === 'fixed' && isNum(airChar.spec.value)) return [airChar.spec.value];
    if (airChar?.spec.mode === 'range') {
      const lo = airChar.spec.min as number | undefined;
      const hi = airChar.spec.max as number | undefined;
      const v = new Set<number>();
      if (lo !== undefined) v.add(lo);
      if (hi !== undefined) v.add(hi);
      if ((lo === undefined || baseline >= lo) && (hi === undefined || baseline <= hi))
        v.add(baseline);
      return [...v].sort((a, b) => a - b);
    }
    return [baseline];
  };

  const build = (stepMul: number, levelsMode: 'all' | 'ends'): ConfigSpec[] => {
    const out: ConfigSpec[] = [];
    const so = scmOptions(stepMul);
    const ao = admixOptions(levelsMode);
    for (const cement of p.cements)
      for (const s of so)
        for (const a of ao)
          for (const nmas of p.nmasList)
            for (const airPct of airOptions(nmas))
              out.push({
                cement,
                scm: s.scm,
                scmPct: s.pct,
                admix: a.admix,
                level: a.level,
                nmas,
                airPct,
              });
    return out.sort((x, y) => (sortKey(x) < sortKey(y) ? -1 : sortKey(x) > sortKey(y) ? 1 : 0));
  };

  let mul = 1;
  let configs = build(mul, 'all');
  const total = configs.length;
  let truncated = false;
  while (configs.length > set.maxConfigurations && mul < 8) {
    mul *= 2;
    configs = build(mul, 'all');
  }
  if (configs.length > set.maxConfigurations) configs = build(mul, 'ends');
  if (configs.length > set.maxConfigurations) {
    // Deterministic even sampling: keep every k-th configuration so the whole grid stays represented.
    const stride = configs.length / set.maxConfigurations;
    configs = Array.from(
      { length: set.maxConfigurations },
      (_, i) => configs[Math.floor(i * stride)]!,
    );
    truncated = true;
  }
  if (configs.length < total)
    notes.push({
      code: 'search_coarsened',
      detail: `${total} configurations exist; ${configs.length} were searched (SCM step ×${mul}${truncated ? ', evenly sampled' : ''}) to stay within the ${set.maxConfigurations} cap`,
    });
  for (const s of p.scms)
    if (!scmChar && p.scmLimits(s).maxPct === null)
      notes.push({
        code: 'scm_cap_defaulted',
        detail: `No SCM maximum is on file for ${s.name}; the search stops at the tenant search cap of ${set.scmSearchCapPct} %`,
      });
  return { configs, total, truncated, blockers, notes };
}
