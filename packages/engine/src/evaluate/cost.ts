// Cost per m³ = Σ kg × JOD/kg delivered at the plant, in exact decimals. A line that cannot be priced makes
// the total "incomplete" and is named; it is never counted as zero.
import { multiply, parseDecimal, roundTo } from '../prices/decimal';
import { toJodPerKg } from '../prices/convert';
import type { QualityItem, CostBlock, CostLine, EvaluationSnapshot } from './types';
import { numProp, sgField, type Tracer } from './util';

export function computeCost(
  s: EvaluationSnapshot,
  tr: Tracer,
): { block: CostBlock; quality: QualityItem[] } {
  const quality: QualityItem[] = [];
  const mats = new Map(s.materials.map((m) => [m.id, m]));
  const lines: CostLine[] = [];
  const missing: CostBlock['missing'] = [];
  let total = 0n;
  let subtotal = 0n;

  for (const l of s.lines) {
    const m = mats.get(l.materialId);
    const base = { materialId: l.materialId, kgPerM3: l.kgPerM3, stale: false };
    const fail = (state: CostLine['state'], reason: string, code: string): void => {
      lines.push({ ...base, jodPerKg: null, jod: null, state, detail: reason });
      missing.push({ materialId: l.materialId, reason });
      quality.push({
        code,
        severity: 'warning',
        materialId: l.materialId,
        detail: reason,
        evidence: ['INPUT_MISSING'],
      });
      tr.add(
        `cost.${l.materialId}`,
        null,
        'JOD/m3',
        'kg × JOD per kg',
        { kg: l.kgPerM3 },
        { evidence: ['INPUT_MISSING'] },
      );
    };
    const p = m?.price;
    if (!p || p.status === 'unavailable') {
      fail(
        'unavailable',
        'no price in force for the evaluation date at this plant',
        'price_missing',
      );
      continue;
    }
    if (p.status === 'ambiguous') {
      fail(
        'ambiguous',
        `several suppliers have a price in force (${p.supplierIds.length}); choose a preferred supplier`,
        'price_ambiguous',
      );
      continue;
    }
    const conv = toJodPerKg({
      price: p.price,
      unit: p.unit,
      sg: numProp(m, sgField(m!.category)) ?? null,
    });
    if (!conv.ok) {
      fail(
        'not_convertible',
        `price in ${p.unit} cannot be converted to JOD/kg (${conv.reason})`,
        'price_not_convertible',
      );
      continue;
    }
    const kg = parseDecimal(l.kgPerM3);
    const perKg = parseDecimal(conv.jodPerKg);
    if (kg === null || perKg === null) {
      fail('not_convertible', 'quantity or price is not a valid decimal', 'price_not_convertible');
      continue;
    }
    const exact = multiply(kg, perKg);
    total += exact;
    subtotal += exact;
    const jod = roundTo(exact, 3);
    const stale = p.staleness === 'stale';
    lines.push({ ...base, jodPerKg: conv.jodPerKg, jod, state: 'priced', stale });
    tr.add(
      `cost.${l.materialId}`,
      jod,
      'JOD/m3',
      'kg × JOD per kg (exact decimal, rounded to 3 places)',
      {
        kg: l.kgPerM3,
        jodPerKg: conv.jodPerKg,
        priceUnit: p.unit,
        price: p.price,
      },
    );
    if (stale)
      quality.push({
        code: 'price_stale',
        severity: 'warning',
        materialId: l.materialId,
        detail: `price is ${p.ageDays} days old (limit exceeded)`,
        evidence: ['INPUT_STALE'],
      });
    else if (p.staleness === 'not_configured')
      quality.push({
        code: 'price_age_limit_not_configured',
        severity: 'info',
        materialId: l.materialId,
        detail: 'no stale-price limit is configured, so price age is not judged',
      });
  }
  const complete = missing.length === 0;
  const totalStr = complete ? roundTo(total, 3) : null;
  tr.add(
    'cost.total',
    totalStr,
    'JOD/m3',
    'Σ exact line costs, rounded once to 3 places (lines are rounded separately for display)',
    {
      lines: lines.length,
      missing: missing.length,
    },
    complete ? {} : { evidence: ['INPUT_MISSING'] },
  );
  tr.add(
    'cost.subtotal',
    roundTo(subtotal, 3),
    'JOD/m3',
    'Σ exact costs of the priced lines only',
    { priced: lines.length - missing.length },
  );
  return {
    block: {
      state: complete ? 'complete' : 'incomplete',
      totalJodPerM3: totalStr,
      subtotalJodPerM3: roundTo(subtotal, 3),
      lines,
      missing,
      basis: s.priceBasis,
    },
    quality,
  };
}
