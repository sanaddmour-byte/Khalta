// Price sensitivity of a stored candidate set. It re-prices the candidates the optimizer already returned; it does NOT
// re-solve, so it cannot find a different (cheaper) mix at the new prices and it never touches a constraint. What it
// answers is narrow and honest: "if this material's price moved by x %, would the ranking of THESE candidates change,
// and by how much would each cost move?". The percentages are the analyst's own what-if inputs, not engineering values.
import type { Candidate } from './types';

export interface SensitivityLine {
  materialId: string;
  /** JOD per m³ the candidate spends on the material (the evaluator's exact priced line). */
  jod: number;
}
export interface SensitivityCandidate {
  id: string;
  rank: number;
  lines: SensitivityLine[];
}

export interface SensitivityScenario {
  materialId: string;
  /** Fractional price change, e.g. 0.1 for +10 %. */
  change: number;
  /** Candidate ids from cheapest to dearest at the changed price. */
  ranking: string[];
  topChanged: boolean;
  /** New total cost of each candidate, JOD/m³. */
  costs: Record<string, number>;
}

export interface SensitivityBreakeven {
  materialId: string;
  /** The smallest price change (either direction) at which the cheapest candidate stops being the cheapest; null when it never does. */
  change: number | null;
  /** The candidate that overtakes it at that change. */
  overtakenBy: string | null;
}

export interface SensitivityReport {
  /** Always false: nothing is re-solved. */
  reSolved: false;
  baseline: { ranking: string[]; costs: Record<string, number> };
  scenarios: SensitivityScenario[];
  breakeven: SensitivityBreakeven[];
}

const total = (c: SensitivityCandidate, change: Record<string, number> = {}) =>
  c.lines.reduce((s, l) => s + l.jod * (1 + (change[l.materialId] ?? 0)), 0);

const rankOf = (cs: SensitivityCandidate[], change: Record<string, number>) =>
  [...cs]
    .map((c) => ({ id: c.id, cost: total(c, change), rank: c.rank }))
    .sort((a, b) => Math.round(a.cost * 1e6) - Math.round(b.cost * 1e6) || a.rank - b.rank);

/** Builds the report. `changes` are fractional price moves to test for every material that appears in any candidate. */
export function priceSensitivity(
  candidates: readonly SensitivityCandidate[],
  changes: readonly number[],
): SensitivityReport {
  const cs = [...candidates];
  const base = rankOf(cs, {});
  const materials = [...new Set(cs.flatMap((c) => c.lines.map((l) => l.materialId)))].sort();
  const scenarios: SensitivityScenario[] = [];
  const breakeven: SensitivityBreakeven[] = [];
  for (const m of materials) {
    for (const ch of changes) {
      const r = rankOf(cs, { [m]: ch });
      scenarios.push({
        materialId: m,
        change: ch,
        ranking: r.map((x) => x.id),
        topChanged: r[0]?.id !== base[0]?.id,
        costs: Object.fromEntries(r.map((x) => [x.id, Math.round(x.cost * 1000) / 1000])),
      });
    }
    // Costs are linear in one material's price: top(δ) = T0 + δ·tm, other(δ) = O0 + δ·om; they cross at δ = (O0 − T0) / (tm − om).
    const top = cs.find((c) => c.id === base[0]?.id);
    let best: { change: number; by: string } | null = null;
    if (top) {
      const tm = top.lines.filter((l) => l.materialId === m).reduce((s, l) => s + l.jod, 0);
      const t0 = total(top);
      for (const o of cs) {
        if (o === top) continue;
        const om = o.lines.filter((l) => l.materialId === m).reduce((s, l) => s + l.jod, 0);
        if (tm === om) continue;
        const d = (total(o) - t0) / (tm - om);
        // the price cannot fall below zero; a crossing that needs it to is not reachable
        if (d <= -1 || d === 0) continue;
        if (best === null || Math.abs(d) < Math.abs(best.change)) best = { change: d, by: o.id };
      }
    }
    breakeven.push({
      materialId: m,
      change: best ? Math.round(best.change * 1e4) / 1e4 : null,
      overtakenBy: best?.by ?? null,
    });
  }
  return {
    reSolved: false,
    baseline: {
      ranking: base.map((x) => x.id),
      costs: Object.fromEntries(base.map((x) => [x.id, Math.round(x.cost * 1000) / 1000])),
    },
    scenarios,
    breakeven,
  };
}

/** Adapts engine candidates (or stored ones) to the sensitivity input. Unpriced lines contribute nothing and are not guessed. */
export function toSensitivityInput(
  rows: { id: string; rank: number; report: Pick<Candidate['report'], 'cost'> }[],
): SensitivityCandidate[] {
  return rows.map((r) => ({
    id: r.id,
    rank: r.rank,
    lines: r.report.cost.lines.flatMap((l) =>
      l.jod !== null ? [{ materialId: l.materialId, jod: Number(l.jod) }] : [],
    ),
  }));
}
