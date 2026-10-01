// Validates docs/spec/06-features.md (the build list) and answers "what is approved for milestone X?".

export const STATUSES = ['proposed', 'approved', 'building', 'done', 'rejected'] as const;
export const PRIORITIES = ['Must', 'Should', 'Could'] as const;
export type Status = (typeof STATUSES)[number];
export type Priority = (typeof PRIORITIES)[number];

export interface Feature {
  id: string;
  title: string;
  priority: Priority;
  milestone: string;
  status: Status;
}

export interface ParseResult {
  features: Feature[];
  errors: string[];
}

const ID = /^F-\d{3}$/;
const MILESTONE = /^M\d\.\d$/;
const stripMd = (s: string) => s.replace(/\*\*/g, '').trim();

export function parseManifest(markdown: string): ParseResult {
  const errors: string[] = [];
  const features: Feature[] = [];
  const seen = new Set<string>();

  // 1. The summary table: | F-001 | Title | Priority | Milestone | Status |
  for (const [i, line] of markdown.split('\n').entries()) {
    if (!/^\|\s*F-/.test(line)) continue;
    const where = `line ${i + 1}`;
    const cells = line
      .split('|')
      .slice(1, -1)
      .map((c) => c.trim());
    if (cells.length !== 5) {
      errors.push(`${where}: expected 5 columns, found ${cells.length}`);
      continue;
    }
    const [id, title, priority, milestone, status] = cells as [
      string,
      string,
      string,
      string,
      string,
    ];
    if (!ID.test(id)) errors.push(`${where}: bad feature id "${id}" (expected F-001 form)`);
    if (seen.has(id)) errors.push(`${where}: duplicate feature id ${id}`);
    seen.add(id);
    if (!(PRIORITIES as readonly string[]).includes(priority))
      errors.push(`${where}: ${id} has invalid priority "${priority}"`);
    if (!MILESTONE.test(milestone))
      errors.push(`${where}: ${id} has invalid milestone "${milestone}"`);
    if (!(STATUSES as readonly string[]).includes(status))
      errors.push(`${where}: ${id} has invalid status "${status}"`);
    features.push({
      id,
      title: stripMd(title),
      priority: priority as Priority,
      milestone,
      status: status as Status,
    });
  }
  if (features.length === 0) errors.push('no features found in the manifest table');

  // 2. Detailed entries must agree with the table.
  const byId = new Map(features.map((f) => [f.id, f]));
  const sections = markdown.split(/^### /m).slice(1);
  for (const sec of sections) {
    const head = sec.split('\n')[0] ?? '';
    const m = head.match(/^(F-\d{3}) — /);
    if (!m) continue;
    const id = m[1]!;
    const f = byId.get(id);
    if (!f) {
      errors.push(`detail entry ${id} has no row in the table`);
      continue;
    }
    const meta = sec.match(/Status:\s*(\w+)\s*·\s*Priority:\s*(\w+)\s*·\s*Milestone:\s*(M\d\.\d)/);
    if (!meta) {
      errors.push(`detail entry ${id} is missing the "Status · Priority · Milestone" line`);
      continue;
    }
    const [, status, priority, milestone] = meta;
    if (status !== f.status)
      errors.push(`${id}: status in detail (${status}) differs from table (${f.status})`);
    if (priority !== f.priority)
      errors.push(`${id}: priority in detail (${priority}) differs from table (${f.priority})`);
    if (milestone !== f.milestone)
      errors.push(`${id}: milestone in detail (${milestone}) differs from table (${f.milestone})`);
    if (!/Acceptance criteria:/.test(sec))
      errors.push(`${id}: detail entry has no acceptance criteria`);
  }
  return { features, errors };
}

/** Approved (or already building) features for one milestone, Must first. */
export function approvedFor(features: Feature[], milestone: string): Feature[] {
  const rank = { Must: 0, Should: 1, Could: 2 } as const;
  return features
    .filter(
      (f) => f.milestone === milestone && (f.status === 'approved' || f.status === 'building'),
    )
    .sort((a, b) => rank[a.priority] - rank[b.priority] || a.id.localeCompare(b.id));
}
