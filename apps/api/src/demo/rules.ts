// SYNTHETIC rule values for the demo/staging dataset ONLY. The shipped seeds leave these empty on purpose (a QC
// manager must supply them from the licensed standards and plant practice), so a real tenant is blocked and told
// what is missing. The demo fills them so every screen can be exercised. Every value written here is a
// plausible placeholder, is stored UNVERIFIED, and carries a clause reference that says it is synthetic. The
// JS values are copies of the ACI values with the same requirement, NOT what the Jordanian standard says.
import type { Client } from './seed';

const NMAS = ['9.5', '12.5', '19', '25', '37.5'];
const perNmas = (v: number) => Object.fromEntries(NMAS.map((n) => [n, v]));

/** Engineering parameters, keyed by rule key. */
export const DEMO_ENGINEERING: Record<string, unknown> = {
  'eng.cement.low_alkali.max_na2o_eq_pct': 0.6,
  'eng.grading.target.band_pct': 12,
  'eng.shilstone.wf.min': perNmas(28),
  'eng.shilstone.wf.max': perNmas(45),
  'eng.fines.max_pct_75um': 9,
  'eng.pumpable.min_passing_0_3mm_pct': 10,
  'eng.drift.tolerance.fm': 0.2,
  'eng.drift.tolerance.sg_ssd': 0.05,
  'eng.drift.tolerance.absorption_pct': 0.5,
  'eng.drift.tolerance.finer_75um_pct': 2,
  'eng.drift.tolerance.sg': 0.03,
  'eng.drift.tolerance.c3a_pct': 1.5,
  'eng.test_age_limit_days.cement': 365,
  'eng.test_age_limit_days.scm': 365,
  'eng.test_age_limit_days.fine_agg': 365,
  'eng.test_age_limit_days.coarse_agg': 365,
  'eng.test_age_limit_days.admixture': 365,
  'eng.moisture.max_total_pct': 12,
  'eng.moisture.stale_hours': 24,
  'eng.trial.air_tolerance_pct': 1.5,
  'eng.trial.density_band_kg_m3': 40,
  'eng.trial.yield_band_m3': 0.02,
  'eng.trial.slump_tolerance_mm': 25,
  'eng.trial.temperature_max_c': 35,
};

/** Aggregate grading limits (percent passing per sieve, mm). Wide enough for the demo aggregates; NOT the ASTM C33 or JS limits. */
export const DEMO_GRADING: Record<string, unknown> = {
  'grading.fine.limits': {
    '9.5': { min: 100, max: 100 },
    '4.75': { min: 90, max: 100 },
    '2.36': { min: 65, max: 100 },
    '1.18': { min: 40, max: 90 },
    '0.6': { min: 20, max: 70 },
    '0.3': { min: 8, max: 40 },
    '0.15': { min: 0, max: 15 },
  },
  // one set applies to every coarse aggregate whatever its size, so it only caps the fines in them
  'grading.coarse.limits': {
    '4.75': { min: 0, max: 25 },
    '2.36': { min: 0, max: 8 },
    '1.18': { min: 0, max: 5 },
    '0.6': { min: 0, max: 3 },
    '0.3': { min: 0, max: 2 },
    '0.15': { min: 0, max: 2 },
  },
};

interface RuleRow {
  id: string;
  ruleset: string;
  key: string;
  requirement: string;
  kind: string;
  value: unknown;
  appliesTo: unknown;
  status: string;
}

/**
 * Fills the empty rule values with the SYNTHETIC set above. Idempotent: only rules with no value are touched, and
 * a second run changes nothing. Written through the same API as the Rules screen (so it is audited).
 */
export async function applyDemoRuleValues(
  admin: Client,
  log: (m: string) => void = () => undefined,
): Promise<number> {
  const { rules } = await admin.get<{ rules: RuleRow[] }>('/api/rules');
  const empty = (r: RuleRow) => r.status === 'missing' && r.kind !== 'table' && r.kind !== 'info';
  let n = 0;
  const set = async (r: RuleRow, value: unknown, clause: string) => {
    await admin.patch(`/api/rules/${r.id}/value`, {
      value,
      clause_ref: clause,
      reason: 'SYNTHETIC demo value so the demo can be exercised; replace with QC values',
    });
    n += 1;
  };
  for (const r of rules.filter(empty)) {
    if (r.ruleset === 'ENGINEERING' && r.key in DEMO_ENGINEERING)
      await set(r, DEMO_ENGINEERING[r.key], 'SYNTHETIC demo value (not a QC-approved parameter)');
    else if (r.ruleset === 'ACI' && r.key in DEMO_GRADING)
      await set(r, DEMO_GRADING[r.key], 'SYNTHETIC demo value (not the licensed standard)');
  }
  // JS: copy the ACI value with the same requirement and conditions (a demo world in which JS is defined)
  const fresh = (await admin.get<{ rules: RuleRow[] }>('/api/rules')).rules;
  const twinKey = (r: RuleRow) => `${r.requirement}|${JSON.stringify(r.appliesTo ?? null)}`;
  const aci = new Map(
    fresh.filter((r) => r.ruleset === 'ACI' && r.value !== null).map((r) => [twinKey(r), r]),
  );
  for (const r of fresh.filter((x) => x.ruleset === 'JS' && empty(x))) {
    const twin = aci.get(twinKey(r));
    if (twin)
      await set(
        r,
        twin.value,
        'SYNTHETIC demo value copied from the ACI rule (NOT the Jordanian standard)',
      );
  }
  log(`${n} synthetic rule values filled`);
  return n;
}
