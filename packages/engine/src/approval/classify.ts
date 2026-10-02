// Change classes for a new design version (01-domain §14.3). Information only: it never moves a state.
// Proportion and admixture changes always go through a trial (minor-adjustment policy default: none).

export type ChangeClass =
  | 'proportion_change'
  | 'admixture_change'
  | 'requirements_change'
  | 'rule_change'
  | 'test_change'
  | 'price_only'
  | 'none';

export interface DesignFacts {
  lines: { materialId: string; kg: number; category: string }[];
  requirements: unknown;
  ruleVersions: Record<string, number>;
  testVersions: Record<string, number>;
  priceBasis: string | null;
}

export interface Classification {
  classes: ChangeClass[];
  /** A new version in these classes must go through a trial again. */
  requiresTrial: boolean;
  deltas: { materialId: string; fromKg: number | null; toKg: number | null }[];
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export function classifyChange(
  from: DesignFacts,
  to: DesignFacts,
  policy: 'none' = 'none',
): Classification {
  const ids = [...new Set([...from.lines, ...to.lines].map((l) => l.materialId))];
  const kg = (d: DesignFacts, id: string) => d.lines.find((l) => l.materialId === id)?.kg ?? null;
  const deltas = ids
    .map((materialId) => ({ materialId, fromKg: kg(from, materialId), toKg: kg(to, materialId) }))
    .filter((d) => d.fromKg === null || d.toKg === null || Math.abs(d.fromKg - d.toKg) > 1e-6);
  const cat = (id: string) =>
    [...from.lines, ...to.lines].find((l) => l.materialId === id)?.category ?? '';
  const classes: ChangeClass[] = [];
  const admixIds = (d: DesignFacts) =>
    d.lines
      .filter((l) => l.category === 'admixture')
      .map((l) => l.materialId)
      .sort();
  if (!same(admixIds(from), admixIds(to))) classes.push('admixture_change');
  if (
    deltas.some((d) => cat(d.materialId) !== 'admixture' || (d.fromKg !== null && d.toKg !== null))
  )
    classes.push('proportion_change');
  if (!same(from.requirements, to.requirements)) classes.push('requirements_change');
  if (!same(from.ruleVersions, to.ruleVersions)) classes.push('rule_change');
  if (!same(from.testVersions, to.testVersions)) classes.push('test_change');
  if (classes.length === 0 && !same(from.priceBasis, to.priceBasis)) classes.push('price_only');
  if (classes.length === 0) classes.push('none');
  void policy; // 'none': there is no minor-adjustment exemption
  return {
    classes,
    requiresTrial: classes.includes('proportion_change') || classes.includes('admixture_change'),
    deltas,
  };
}
