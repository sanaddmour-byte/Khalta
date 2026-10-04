// Trial acceptance (01-domain §14.4). Pure: given the QC-configured criteria and the logged trial batches it
// says, criterion by criterion, pass / fail / missing. A missing criterion BLOCKS `trial_passed` and is named;
// nothing is defaulted. The batches arrive with M4.2 (entry screens); the shape is fixed here.

export interface TrialCriteria {
  /** ± mm around the target slump (C94 / project tolerance). */
  slumpToleranceMm: number | null;
  /** ± percentage points around the target air content. */
  airTolerancePct: number | null;
  /** ± kg/m³ around the calculated fresh density. */
  densityBandKgM3: number | null;
  /** ± m³ around 1.000 yield. */
  yieldBandM3: number | null;
  /** Maximum concrete temperature, °C (hot-weather limit). */
  temperatureMaxC: number | null;
  /**
   * Criteria beyond the five measured ones. Each is applied only when QC has configured it, and a requirement that
   * names it (a pumpable mix) with no criterion on file blocks instead of passing silently. None has a default.
   */
  /** Workability retention: the slump measured after `retentionMinutes` must be at least this (mm). */
  retentionMinSlumpMm?: number | null;
  /** The age (minutes after mixing) at which the retained slump must be measured. */
  retentionMinutes?: number | null;
  /** 1 when stability (bleeding and segregation) must be observed and found acceptable. */
  stabilityRequired?: number | null;
  /** 1 when placement (pumping and finishing) must be observed and found acceptable. */
  placementRequired?: number | null;
}

export const STABILITY_OBSERVATIONS = [
  'stable',
  'bleeding',
  'segregation',
  'bleeding_and_segregation',
] as const;
export type StabilityObservation = (typeof STABILITY_OBSERVATIONS)[number];

export interface TrialBatch {
  id: string;
  batchedOn: string; // YYYY-MM-DD
  slumpMm: number | null;
  airPct: number | null;
  temperatureC: number | null;
  freshDensityKgM3: number | null;
  yieldM3: number | null;
  /** Slump after the retention time, and how many minutes after mixing it was taken. */
  retainedSlumpMm?: number | null;
  retentionMinutes?: number | null;
  /** What was seen: only `stable` satisfies a configured stability criterion. */
  stability?: StabilityObservation | null;
  /** Whether the mix pumped and finished acceptably (an observation by the person at the batch). */
  placementAcceptable?: boolean | null;
  /** Individual specimen results at the design's test age (MPa). */
  strengthMpa: number[];
}

export interface TrialTargets {
  slumpMm: number | null;
  airPct: number | null;
  /** The evaluator's calculated fresh density (kg/m³). */
  densityKgM3: number | null;
  /** Required average strength f′cr (MPa) from the stored evaluation. */
  fcrMpa: number | null;
  /** The design must be pumpable: placement then needs a configured criterion. */
  pumpable?: boolean;
}

export type CriterionStatus = 'pass' | 'fail' | 'missing' | 'not_applicable';
export interface CriterionResult {
  id:
    | 'slump'
    | 'air'
    | 'density'
    | 'yield'
    | 'temperature'
    | 'strength'
    | 'retention'
    | 'stability'
    | 'placement';
  status: CriterionStatus;
  /** Rule key of a missing parameter, or the reason a measurement is missing. */
  missing?: string;
  measured?: number | null;
  target?: number | null;
  limit?: number | null;
}
export interface TrialAcceptance {
  ok: boolean;
  batchId: string | null;
  criteria: CriterionResult[];
}

const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Judged on the latest batch (by date, then id); strength is that batch's specimen average vs f′cr. */
export function evaluateTrialAcceptance(
  criteria: TrialCriteria,
  targets: TrialTargets,
  batches: readonly TrialBatch[],
): TrialAcceptance {
  const batch = [...batches].sort((a, b) =>
    a.batchedOn === b.batchedOn ? a.id.localeCompare(b.id) : a.batchedOn.localeCompare(b.batchedOn),
  )[batches.length - 1];
  const out: CriterionResult[] = [];
  const within = (
    id: CriterionResult['id'],
    key: string,
    measured: number | null | undefined,
    target: number | null,
    tol: number | null,
  ) => {
    if (target === null) return out.push({ id, status: 'not_applicable' });
    if (tol === null) return out.push({ id, status: 'missing', missing: key });
    if (!num(measured)) return out.push({ id, status: 'missing', missing: 'measurement' });
    const ok = Math.abs(measured - target) <= tol + 1e-9;
    out.push({ id, status: ok ? 'pass' : 'fail', measured, target, limit: tol });
  };
  within(
    'slump',
    'eng.trial.slump_tolerance_mm',
    batch?.slumpMm,
    targets.slumpMm,
    criteria.slumpToleranceMm,
  );
  within(
    'air',
    'eng.trial.air_tolerance_pct',
    batch?.airPct,
    targets.airPct,
    criteria.airTolerancePct,
  );
  within(
    'density',
    'eng.trial.density_band_kg_m3',
    batch?.freshDensityKgM3,
    targets.densityKgM3,
    criteria.densityBandKgM3,
  );
  within('yield', 'eng.trial.yield_band_m3', batch?.yieldM3, 1, criteria.yieldBandM3);
  // temperature: an upper limit, always applicable
  if (criteria.temperatureMaxC === null)
    out.push({ id: 'temperature', status: 'missing', missing: 'eng.trial.temperature_max_c' });
  else if (!num(batch?.temperatureC))
    out.push({ id: 'temperature', status: 'missing', missing: 'measurement' });
  else
    out.push({
      id: 'temperature',
      status: batch.temperatureC <= criteria.temperatureMaxC ? 'pass' : 'fail',
      measured: batch.temperatureC,
      limit: criteria.temperatureMaxC,
    });
  // strength: average of the specimens ≥ f′cr (ACI 301 trial mixture)
  if (!num(targets.fcrMpa)) out.push({ id: 'strength', status: 'missing', missing: 'fcr' });
  else if (!batch || batch.strengthMpa.length === 0)
    out.push({ id: 'strength', status: 'missing', missing: 'measurement' });
  else {
    const avg = batch.strengthMpa.reduce((a, b) => a + b, 0) / batch.strengthMpa.length;
    out.push({
      id: 'strength',
      status: avg + 1e-9 >= targets.fcrMpa ? 'pass' : 'fail',
      measured: Math.round(avg * 100) / 100,
      target: targets.fcrMpa,
    });
  }
  // ---- optional criteria: applied when configured; a stated requirement with none on file blocks
  const retMin = criteria.retentionMinSlumpMm ?? null;
  const retAt = criteria.retentionMinutes ?? null;
  if (retMin === null && retAt === null) out.push({ id: 'retention', status: 'not_applicable' });
  else if (retMin === null || retAt === null)
    out.push({
      id: 'retention',
      status: 'missing',
      missing: retMin === null ? 'eng.trial.retention_min_slump_mm' : 'eng.trial.retention_minutes',
    });
  else if (!num(batch?.retainedSlumpMm) || !num(batch?.retentionMinutes))
    out.push({ id: 'retention', status: 'missing', missing: 'measurement' });
  else if (batch.retentionMinutes + 1e-9 < retAt)
    out.push({
      id: 'retention',
      status: 'missing',
      missing: 'measurement_too_early',
      measured: batch.retainedSlumpMm,
      limit: retMin,
    });
  else
    out.push({
      id: 'retention',
      status: batch.retainedSlumpMm + 1e-9 >= retMin ? 'pass' : 'fail',
      measured: batch.retainedSlumpMm,
      limit: retMin,
    });
  if ((criteria.stabilityRequired ?? null) !== 1)
    out.push({ id: 'stability', status: 'not_applicable' });
  else if (!batch?.stability)
    out.push({ id: 'stability', status: 'missing', missing: 'measurement' });
  else out.push({ id: 'stability', status: batch.stability === 'stable' ? 'pass' : 'fail' });
  const placementOn = (criteria.placementRequired ?? null) === 1;
  if (!placementOn && targets.pumpable)
    out.push({ id: 'placement', status: 'missing', missing: 'eng.trial.placement_required' });
  else if (!placementOn) out.push({ id: 'placement', status: 'not_applicable' });
  else if (typeof batch?.placementAcceptable !== 'boolean')
    out.push({ id: 'placement', status: 'missing', missing: 'measurement' });
  else out.push({ id: 'placement', status: batch.placementAcceptable ? 'pass' : 'fail' });
  return {
    ok: !!batch && out.every((c) => c.status === 'pass' || c.status === 'not_applicable'),
    batchId: batch?.id ?? null,
    criteria: out,
  };
}
