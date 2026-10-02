// Structured reasons: every explanation the evaluator writes in English is also given a stable key and
// parameters, so the UI can show it in either language while the stored report keeps the English text for
// audit. The patterns below are the single place that maps text to a key; a test over the whole scenario
// catalogue fails if the evaluator writes a sentence no pattern recognizes.
import type { EvaluationReport, Reason } from './types';

type Rule = [RegExp, string, string[]];

const RULES: Rule[] = [
  [/^Air content ([\d.]+) % is the ACI 211\.1 entrapped-air value/, 'air_baseline_used', ['value']],
  [/^Exposure F1–F3 implies an air-entrained design/, 'air_entrained_assumed', []],
  [
    /^Slump ([\d.]+) mm is between the ACI 211\.1 slump ranges ([\d–]+) and ([\d–]+) mm/,
    'slump_between_bins',
    ['slump', 'lower', 'upper'],
  ],
  [/^Water specific gravity taken as 1\.000/, 'water_sg_assumed', []],
  [/^water specific gravity is not on file; 1\.000 was used/, 'water_sg_defaulted', []],
  [/^Strength is specified at (\d+) days/, 'strength_age_assumed', ['days']],
  [
    /^(.+) is ambiguous on the basis map \(candidates for ([\d.]+) MPa\)/,
    'b_grade_ambiguous',
    ['grade', 'fc'],
  ],
  [/^cube strength ([\d.]+) MPa is not a class on the basis map/, 'cube_not_on_map', ['value']],
  [/^B-?grade .* is not on the basis map/, 'b_grade_not_on_map', []],
  [/^(\w+): (fcr\..+) not on file$/, 'fcr_rules_not_on_file', ['ruleset', 'keys']],
  [/^NMAS is not stated(, so entrapped air cannot be estimated)?$/, 'nmas_not_stated', []],
  [
    /^NMAS ([\d.]+) is outside the table domain ([\d.]+)–([\d.]+)/,
    'nmas_out_of_domain',
    ['value', 'min', 'max'],
  ],
  [
    /^(.+): dosage ([\d.]+) % is outside the table ([\d.]+)–([\d.]+) %/,
    'dosage_out_of_table',
    ['material', 'dosage', 'min', 'max'],
  ],
  [
    /^(.+): the dosage–water-reduction table is not on file/,
    'reduction_table_missing',
    ['material'],
  ],
  [
    /^f'cr ([\d.]+) is outside the table domain ([\d.]+)–([\d.]+)/,
    'fcr_out_of_domain',
    ['value', 'min', 'max'],
  ],
  [/^prop\.[\w.]+ is not on file \(air-entrained/, 'air_entrained_tables_missing', []],
  [/^prop\.[\w.*]+ table is not on file for this request/, 'air_entrained_tables_missing', []],
  [/^required average strength f'cr is not available/, 'fcr_unavailable', []],
  [/^slump is not stated/, 'slump_not_stated', []],
  [/^slump or NMAS is outside the ACI 211\.1 table domain/, 'slump_or_nmas_out_of_domain', []],
  [/^specified strength is not stated/, 'fc_not_stated', []],
  [/^strength basis \(cylinder, cube or B-grade\) is not stated/, 'basis_not_stated', []],
  [/^evaluated from M3\.1/, 'from_m31', []],
  [/^the requested dosage level is compared from M3\.1/, 'dosage_level_from_m31', []],
  [/^the value cannot be computed from the given proportions/, 'value_not_computable', []],
  [/^C3A is not on file for (.+)$/, 'c3a_missing', ['materials']],
  [/^SCM type is not recorded for (.+)$/, 'scm_type_missing', ['materials']],
  [/^admixture type is not recorded for (.+)$/, 'admixture_type_missing', ['materials']],
  [/^air content is not stated in the design/, 'air_not_stated', []],
  [
    /^cannot tell whether "([^"]+)" applies: the request lacks (.+)$/,
    'context_missing',
    ['rule', 'fields'],
  ],
  [/^cement\.equivalence C3A limits are not on file/, 'cement_equivalence_missing', []],
  [/^chloride content not on file: (.+)$/, 'chloride_data_missing', ['items']],
  [/^no applicable rule has a value on file/, 'rule_value_missing', []],
  [/^no cementitious material( in the design| to base the dosage on)?$/, 'no_cementitious', []],
  [/^the design has no cementitious material/, 'no_cementitious', []],
  [/^the design has no (cement|water line)$/, 'design_lacks_line', ['what']],
  [/^specific gravity is missing for (.+)$/, 'sg_missing', ['materials']],
  [/^the product dosage range is not on file/, 'dosage_range_missing', []],
  [/^no price in force for the evaluation date/, 'price_missing', []],
  [
    /^price in (\S+) cannot be converted to JOD\/kg \((\w+)\)/,
    'price_not_convertible',
    ['unit', 'why'],
  ],
  [/^several suppliers have a price in force \((\d+)\)/, 'price_ambiguous', ['count']],
  [/^price is (\d+) days old/, 'price_stale', ['days']],
  [/^no stale-price limit is configured/, 'price_age_limit_not_configured', []],
  [/^the admixture water convention is not set/, 'admixture_convention_missing', []],
  [/^admixture solids content is not on file/, 'admixture_solids_missing', []],
  [/^limestone filler is not counted as an SCM/, 'limestone_not_counted', []],
  [/^material record not found/, 'material_missing', []],
  [/^no near-limit warning percentage is configured/, 'near_limit_not_configured', []],
  [/^no strength records exist/, 'no_strength_records', []],
  [/^project value for (.+) would loosen the code limit/, 'override_rejected', ['requirement']],
  [/^(\d+) applicable rule value\(s\) are not on file/, 'rules_missing', ['count']],
  [
    /^(\d+) rule value\(s\) used by this evaluation are not yet verified/,
    'rules_unverified',
    ['count'],
  ],
  [/^no f'cr safety margin is configured/, 'margin_not_configured', []],
  [/^test v(\d+) of ([\d-]+) is past its validity/, 'test_expired', ['version', 'date']],
  [/^no test data on file/, 'test_missing', []],
  [/^no test-age limit is configured/, 'test_age_limit_not_configured', []],
  [/^user-declared key values: (.+)$/, 'declared_values', ['fields']],
  [/^accelerating admixtures \(ASTM C494 Types C and E\)/, 'note_cacl2', []],
  [/^cement and SCM chloride are not in the test schema/, 'note_chloride_scope', []],
  [/^judged by C3A of every cement line/, 'note_c3a', []],
  [/^presence of the required SCM only/, 'note_scm_required', []],
  [/^product range (.+) %$/, 'note_product_range', ['range']],
  [/^target ± ([\d.]+) %/, 'note_air_band', ['tolerance']],
  [/^specified f'c on the cylinder basis/, 'note_min_fc', []],
  [/^volume could not be computed/, 'volume_not_computable', []],
  [/^a value needed for this check is missing/, 'check_value_missing', []],
  [/no numeric value on file$/, 'rule_value_missing', []],
];

export function reasonOf(text: string): Reason {
  for (const [re, key, names] of RULES) {
    const m = re.exec(text);
    if (m) return { key, params: Object.fromEntries(names.map((n, i) => [n, m[i + 1] ?? ''])) };
  }
  return { key: 'other', params: { text } };
}

/** Adds `reason` next to every English explanation in a report (the English text is kept unchanged). */
export function attachReasons(r: EvaluationReport): EvaluationReport {
  for (const c of r.checks) {
    if (c.blocker) c.blocker.reason = reasonOf(c.blocker.detail);
    if (c.note) c.noteReason = reasonOf(c.note);
  }
  for (const b of [
    r.strength.blocker,
    r.strengthAdequacy.blocker,
    r.waterBaseline.blocker,
    ...r.strength.branches.map((x) => x.blocker),
    ...r.characteristics.rows.map((x) => x.blocker),
  ])
    if (b) b.reason = reasonOf(b.detail);
  for (const q of r.dataQuality) q.reason = reasonOf(q.detail);
  for (const l of r.cost.lines) if (l.detail) l.reason = reasonOf(l.detail);
  r.assumptionReasons = r.assumptions.map(reasonOf);
  return r;
}

/** Every key a reason can carry (the UI must have a translation for each). */
export const REASON_KEYS: readonly string[] = [...new Set([...RULES.map((r) => r[1]), 'other'])];
