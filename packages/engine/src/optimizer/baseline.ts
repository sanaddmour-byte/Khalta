// The ACI 211.1 absolute-volume proportioning path for ONE chosen cement, fine and coarse aggregate: mixing
// water from the slump/NMAS table, cement = water ÷ (w/c for f'cr), coarse aggregate from the dry-rodded
// volume table, fine aggregate by the volume that remains. A published heuristic (MODEL_BASELINE), kept as a
// reference the optimizer's candidates can be compared with and as the golden path for the tests; it is
// never offered as a design.
import { lookupTable, type TableDefinition } from '@khalta/rules';
import { fineModulus } from '../materials/gradation';
import { numProp } from '../evaluate/util';
import type { AggMat, CementMat, Prepared } from './prepare';

export type AciBaseline =
  | {
      ok: true;
      wc: number;
      waterKg: number;
      cementKg: number;
      airPct: number;
      fmSand: number;
      caVolumeFraction: number;
      caKg: number;
      faKg: number;
      lines: { materialId: string; kg: number }[];
    }
  | { ok: false; detail: string };

export function aciBaseline(
  p: Prepared,
  pick: { nmas: number; cement: CementMat; fine: AggMat; coarse: AggMat },
): AciBaseline {
  const water = p.baseWaterKg.get(pick.nmas);
  const air = p.airByNmas.get(pick.nmas);
  if (water === undefined || air === undefined)
    return { ok: false, detail: 'water or air baseline is not available for this NMAS' };
  if (p.baselineWc <= 0) return { ok: false, detail: "no w/c baseline for f'cr" };
  const rule = p.rules.value('ACI', 'prop.ca_volume') as TableDefinition | null;
  const fm = fineModulus(pick.fine.points, p.guard.base.fmSieves);
  if (!fm.ok) return { ok: false, detail: 'the fine aggregate FM cannot be computed' };
  const frac = lookupTable(rule, { row: pick.nmas, col: fm.fm });
  if (frac.status !== 'ok')
    return {
      ok: false,
      detail: `prop.ca_volume has no value at NMAS ${pick.nmas} mm and FM ${fm.fm}`,
    };
  const dr = numProp(pick.coarse.m, 'dry_rodded_unit_weight_kg_m3');
  if (dr === undefined)
    return { ok: false, detail: 'the coarse aggregate dry-rodded unit weight is not on file' };
  const cement = water / p.baselineWc;
  const caKg = frac.value * dr;
  const volume =
    cement / (pick.cement.sg * 1000) +
    water / (p.water.sg * 1000) +
    air / 100 +
    caKg / pick.coarse.rho;
  const faVol = 1 - volume;
  if (faVol <= 0)
    return { ok: false, detail: 'the baseline leaves no volume for the fine aggregate' };
  const faKg = faVol * pick.fine.rho;
  return {
    ok: true,
    wc: p.baselineWc,
    waterKg: water,
    cementKg: cement,
    airPct: air,
    fmSand: fm.fm,
    caVolumeFraction: frac.value,
    caKg,
    faKg,
    lines: [
      { materialId: pick.cement.id, kg: cement },
      { materialId: p.water.id, kg: water },
      { materialId: pick.fine.id, kg: faKg },
      { materialId: pick.coarse.id, kg: caKg },
    ],
  };
}
