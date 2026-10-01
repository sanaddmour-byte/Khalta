import { applicability, type Context } from './applicability';
import { isTighterOrEqual, mergeValues, TIGHTENABLE } from './merge';
import { CODE_RULESETS, type RuleKind, type RuleRecord, type Units } from './schema';

export type Mode = 'ACI' | 'JS' | 'BOTH';
export type Source = 'ACI' | 'JS' | 'PROJECT';

export interface ProjectOverride {
  requirement: string;
  value: unknown;
  /** Required when the requirement is not defined by the codes; must match the code's kind otherwise. */
  kind?: RuleKind;
  units?: Units;
  /** Where in the project specification this comes from (shown as the clause). */
  clause_ref?: string;
}

export interface ResolveOptions {
  mode: Mode;
  context: Context;
  projectOverrides?: ProjectOverride[];
  /** For `table` requirements defined by both codes: which code's table to use (never guessed). */
  tablePolicy?: Record<string, 'ACI' | 'JS'>;
}

export interface Contribution {
  source: Source | string;
  ruleKey: string;
  ruleId: string;
  version: number;
  value: unknown | null;
  clause_ref: string;
  verified: boolean;
  requirement_class: string;
}

export type IssueCode =
  | 'other_side_missing' // one code has no value: result is provisional on the other
  | 'value_missing' // no applicable rule has a value
  | 'empty_intersection'
  | 'table_policy_required'
  | 'conflict'
  | 'context_missing' // a rule might apply but the request lacks a field (e.g. S3 without an option)
  | 'override_loosens'
  | 'override_not_allowed'
  | 'override_kind_mismatch';

export interface Issue {
  code: IssueCode;
  requirement: string;
  message: string;
  fields?: string[];
  ruleKeys?: string[];
}

export interface ResolvedRequirement {
  requirement: string;
  kind: RuleKind;
  units: Units;
  value: unknown | null;
  /** resolved: usable; provisional: usable but incomplete (e.g. only one code known); blocked: no usable value. */
  status: 'resolved' | 'provisional' | 'blocked';
  governing: Contribution | null;
  /** Every applicable rule from the selected sources, including those without a value. */
  contributions: Contribution[];
  issues: Issue[];
  /** True only if every contribution has a value and is verified. */
  verified: boolean;
}

export interface RejectedOverride {
  requirement: string;
  proposed: unknown;
  code: 'override_loosens' | 'override_not_allowed' | 'override_kind_mismatch';
  message: string;
  /** The bound the user may not loosen, with its source and clause. */
  allowed: unknown;
  governing: Contribution | null;
}

export interface ResolveResult {
  mode: Mode;
  requirements: ResolvedRequirement[];
  /** Issues not attached to a produced value (e.g. context_missing). */
  issues: Issue[];
  rejectedOverrides: RejectedOverride[];
}

const sourcesFor = (mode: Mode): string[] => (mode === 'BOTH' ? [...CODE_RULESETS] : [mode]);

function contribution(r: RuleRecord, value: unknown): Contribution {
  return {
    source: r.ruleset,
    ruleKey: r.key,
    ruleId: r.id,
    version: r.version,
    value,
    clause_ref: r.clause_ref,
    verified: r.verified,
    requirement_class: r.requirement_class,
  };
}

/** `inherits: "ACI:<key>"` resolves to the referenced rule's value (a reference, not a copy). */
export function effectiveValue(
  rule: RuleRecord,
  byRef: Map<string, RuleRecord>,
  seen = new Set<string>(),
): unknown | null {
  if (!rule.inherits) return rule.kind === 'table' ? (rule.definition ?? null) : rule.value;
  if (seen.has(rule.inherits)) return null; // cycle: treated as missing
  seen.add(rule.inherits);
  const target = byRef.get(rule.inherits);
  return target ? effectiveValue(target, byRef, seen) : null;
}

interface Group {
  requirement: string;
  kind: RuleKind;
  units: Units;
  bySource: Map<string, { rule: RuleRecord; value: unknown | null }[]>;
}

export function resolve(rules: RuleRecord[], opts: ResolveOptions): ResolveResult {
  const sources = sourcesFor(opts.mode);
  const byRef = new Map(rules.map((r) => [`${r.ruleset}:${r.key}`, r]));
  const groups = new Map<string, Group>();
  const issues: Issue[] = [];
  const blockedByContext = new Map<string, Issue>();

  for (const rule of rules) {
    if (!sources.includes(rule.ruleset)) continue;
    const a = applicability(rule, opts.context);
    if (a.applies === 'no') continue;
    if (a.applies === 'undetermined') {
      const issue: Issue = {
        code: 'context_missing',
        requirement: rule.requirement,
        message: `cannot tell whether "${rule.key}" applies: the request lacks ${a.fields.join(', ')}`,
        fields: a.fields,
        ruleKeys: [rule.key],
      };
      const k = `${rule.requirement}|${a.fields.join(',')}`;
      const prior = blockedByContext.get(k);
      if (prior) prior.ruleKeys = [...new Set([...(prior.ruleKeys ?? []), rule.key])];
      else blockedByContext.set(k, issue);
      if (!groups.has(rule.requirement))
        groups.set(rule.requirement, {
          requirement: rule.requirement,
          kind: rule.kind,
          units: rule.units,
          bySource: new Map(),
        });
      continue;
    }
    let g = groups.get(rule.requirement);
    if (!g)
      groups.set(
        rule.requirement,
        (g = {
          requirement: rule.requirement,
          kind: rule.kind,
          units: rule.units,
          bySource: new Map(),
        }),
      );
    const list = g.bySource.get(rule.ruleset) ?? [];
    list.push({ rule, value: effectiveValue(rule, byRef) });
    g.bySource.set(rule.ruleset, list);
  }

  const out: ResolvedRequirement[] = [];
  for (const g of [...groups.values()].sort((a, b) => a.requirement.localeCompare(b.requirement))) {
    const reqIssues: Issue[] = [...blockedByContext.values()].filter(
      (i) => i.requirement === g.requirement,
    );
    const contributions: Contribution[] = [];
    const perSource: {
      source: string;
      value: unknown | null;
      winner: Contribution | null;
      partial: boolean;
    }[] = [];

    for (const source of sources) {
      const entries = g.bySource.get(source);
      if (!entries) continue; // this code does not define the requirement
      for (const e of entries) contributions.push(contribution(e.rule, e.value));
      const present = entries.filter((e) => e.value !== null);
      if (present.length === 0) {
        perSource.push({ source, value: null, winner: null, partial: false });
        continue;
      }
      const m = mergeValues(
        g.kind,
        present.map((e) => e.value),
      );
      if (!m.ok) {
        reqIssues.push({
          code: m.code,
          requirement: g.requirement,
          message: `${source}: ${m.message}`,
          ruleKeys: present.map((e) => e.rule.key),
        });
        perSource.push({ source, value: null, winner: null, partial: false });
        continue;
      }
      const w = present[m.winner]!;
      perSource.push({
        source,
        value: m.value,
        winner: contribution(w.rule, w.value),
        partial: present.length < entries.length,
      });
    }

    if (g.kind === 'info') {
      // Informational rows (e.g. structural cover) are listed, never constraints: no value is not a gap.
      out.push({
        requirement: g.requirement,
        kind: g.kind,
        units: g.units,
        value: perSource.find((p) => p.value !== null)?.value ?? null,
        status: 'resolved',
        governing: perSource.find((p) => p.winner)?.winner ?? null,
        contributions,
        issues: reqIssues.filter((i) => i.code === 'context_missing'),
        verified:
          contributions.length > 0 && contributions.every((c) => c.verified || c.value === null),
      });
      continue;
    }
    const known = perSource.filter((p) => p.value !== null);
    const missingSources = perSource.filter((p) => p.value === null).map((p) => p.source);
    let value: unknown | null = null;
    let governing: Contribution | null = null;
    let status: ResolvedRequirement['status'] = 'blocked';
    const conflictAlready = reqIssues.some((i) =>
      ['empty_intersection', 'conflict'].includes(i.code),
    );

    if (!conflictAlready && known.length === 1) {
      value = known[0]!.value;
      governing = known[0]!.winner;
      status = 'resolved';
    } else if (!conflictAlready && known.length > 1) {
      if (g.kind === 'table') {
        const pick = opts.tablePolicy?.[g.requirement];
        const chosen = known.find((p) => p.source === pick);
        if (chosen) {
          value = chosen.value;
          governing = chosen.winner;
          status = 'resolved';
        } else {
          reqIssues.push({
            code: 'table_policy_required',
            requirement: g.requirement,
            message: 'both codes define this table; choose which one applies (tablePolicy)',
          });
        }
      } else {
        const m = mergeValues(
          g.kind,
          known.map((p) => p.value),
        );
        if (m.ok) {
          value = m.value;
          governing = known[m.winner]!.winner;
          status = 'resolved';
        } else reqIssues.push({ code: m.code, requirement: g.requirement, message: m.message });
      }
    }

    if (status === 'resolved') {
      if (missingSources.length > 0) {
        status = 'provisional';
        reqIssues.push({
          code: 'other_side_missing',
          requirement: g.requirement,
          message: `no value on file for ${missingSources.join(', ')}; using the other code provisionally`,
          ruleKeys: contributions.filter((c) => c.value === null).map((c) => c.ruleKey),
        });
      } else if (perSource.some((p) => p.partial)) {
        status = 'provisional';
        reqIssues.push({
          code: 'value_missing',
          requirement: g.requirement,
          message: 'some applicable rules have no value on file',
          ruleKeys: contributions.filter((c) => c.value === null).map((c) => c.ruleKey),
        });
      }
    } else if (!reqIssues.some((i) => i.code !== 'value_missing')) {
      reqIssues.push({
        code: 'value_missing',
        requirement: g.requirement,
        message: 'no applicable rule has a value on file',
        ruleKeys: contributions.map((c) => c.ruleKey),
      });
    }
    if (reqIssues.some((i) => i.code === 'context_missing') && status !== 'blocked')
      status = 'provisional';

    out.push({
      requirement: g.requirement,
      kind: g.kind,
      units: g.units,
      value,
      status,
      governing,
      contributions,
      issues: reqIssues,
      verified:
        contributions.length > 0 && contributions.every((c) => c.value !== null && c.verified),
    });
  }

  const rejected: RejectedOverride[] = [];
  for (const ov of opts.projectOverrides ?? []) {
    const base = out.find((r) => r.requirement === ov.requirement);
    const reject = (code: RejectedOverride['code'], message: string) => {
      rejected.push({
        requirement: ov.requirement,
        proposed: ov.value,
        code,
        message,
        allowed: base?.value ?? null,
        governing: base?.governing ?? null,
      });
      issues.push({ code, requirement: ov.requirement, message });
    };
    const kind = base?.kind ?? ov.kind;
    if (!kind || !TIGHTENABLE.includes(kind)) {
      reject(
        'override_not_allowed',
        `"${ov.requirement}" cannot be overridden by a project specification (kind: ${kind ?? 'unknown'})`,
      );
      continue;
    }
    if (base && ov.kind && ov.kind !== base.kind) {
      reject(
        'override_kind_mismatch',
        `"${ov.requirement}" is a ${base.kind} in the codes, not a ${ov.kind}`,
      );
      continue;
    }
    const projectContribution: Contribution = {
      source: 'PROJECT',
      ruleKey: `project.${ov.requirement}`,
      ruleId: `PROJECT:${ov.requirement}`,
      version: 1,
      value: ov.value,
      clause_ref: ov.clause_ref ?? 'PROJECT',
      verified: true, // the project specification is the user's own declared source
      requirement_class: 'PROJECT_HARD',
    };
    if (!base) {
      out.push({
        requirement: ov.requirement,
        kind,
        units: ov.units ?? 'none',
        value: ov.value,
        status: 'resolved',
        governing: projectContribution,
        contributions: [projectContribution],
        issues: [],
        verified: true,
      });
      out.sort((a, b) => a.requirement.localeCompare(b.requirement));
      continue;
    }
    if (base.value === null) {
      // The codes give nothing to tighten against: the project value stands, but the result stays provisional.
      base.value = ov.value;
      base.governing = projectContribution;
      base.contributions.push(projectContribution);
      if (base.status === 'blocked') base.status = 'provisional';
      continue;
    }
    if (!isTighterOrEqual(base.kind, base.value, ov.value)) {
      const g = base.governing;
      reject(
        'override_loosens',
        `would loosen ${String(base.value)} (${g?.source ?? ''} ${g?.clause_ref ?? ''}); a project specification may only tighten code limits`,
      );
      continue;
    }
    base.contributions.push(projectContribution);
    const equal = JSON.stringify(ov.value) === JSON.stringify(base.value);
    if (!equal) {
      base.value = ov.value;
      base.governing = projectContribution;
    }
  }

  return {
    mode: opts.mode,
    requirements: out,
    issues: [
      ...issues,
      ...[...blockedByContext.values()].filter(
        (i) => !out.some((r) => r.requirement === i.requirement),
      ),
    ],
    rejectedOverrides: rejected,
  };
}

export interface ApprovalBlockers {
  unverified: { requirement: string; ruleKey: string; source: string }[];
  missing: { requirement: string; ruleKey: string; source: string }[];
  /** Requirements that are provisional or blocked (including context gaps). */
  incomplete: { requirement: string; status: string; issues: IssueCode[] }[];
  approvable: boolean;
}

/** Approval is blocked if any rule a design depends on (in the selected mode) is unverified or null. */
export function approvalBlockers(result: ResolveResult): ApprovalBlockers {
  const unverified: ApprovalBlockers['unverified'] = [];
  const missing: ApprovalBlockers['missing'] = [];
  const incomplete: ApprovalBlockers['incomplete'] = [];
  for (const r of result.requirements) {
    for (const c of r.contributions) {
      if (r.kind === 'info') continue; // never a constraint
      if (c.value === null)
        missing.push({ requirement: r.requirement, ruleKey: c.ruleKey, source: String(c.source) });
      else if (!c.verified)
        unverified.push({
          requirement: r.requirement,
          ruleKey: c.ruleKey,
          source: String(c.source),
        });
    }
    if (r.status !== 'resolved')
      incomplete.push({
        requirement: r.requirement,
        status: r.status,
        issues: r.issues.map((i) => i.code),
      });
  }
  for (const i of result.issues)
    incomplete.push({ requirement: i.requirement, status: 'blocked', issues: [i.code] });
  return {
    unverified,
    missing,
    incomplete,
    approvable:
      !unverified.length &&
      !missing.length &&
      !incomplete.length &&
      !result.rejectedOverrides.length,
  };
}
