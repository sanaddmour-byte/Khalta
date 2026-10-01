import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import '../src/i18n';
import { clearAllDrafts, clearDraft, loadDraft, saveDraft } from '../src/materials/drafts';
import { fieldsFor } from '../src/materials/fields';
import { parseNumber } from '../src/materials/number';
import { Sparkline } from '../src/materials/Sparkline';

describe('parseNumber', () => {
  it('reads Western and Arabic-Indic digits with point or comma decimals', () => {
    expect(parseNumber('2.65')).toBe(2.65);
    expect(parseNumber('2,65')).toBe(2.65);
    expect(parseNumber('٢٫٦٥')).toBe(2.65);
    expect(parseNumber('۲٫۶۵')).toBe(2.65);
    expect(parseNumber(' 12 ')).toBe(12);
    expect(parseNumber('-1')).toBe(-1);
  });
  it('returns null for empty or non-numeric text', () => {
    for (const s of ['', ' ', 'abc', '1.2.3', '1e3', '--1']) expect(parseNumber(s)).toBeNull();
  });
});

describe('fieldsFor (tiers come from the engine minimum sets)', () => {
  const tier = (c: Parameters<typeof fieldsFor>[0], key: string) =>
    fieldsFor(c).find((f) => f.key === key)?.tier;
  it('aggregate: SG and absorption evaluate; fines design; the rest optional', () => {
    expect(tier('fine_agg', 'sg_ssd')).toBe('evaluate');
    expect(tier('fine_agg', 'absorption_pct')).toBe('evaluate');
    expect(tier('fine_agg', 'finer_75um_pct')).toBe('design');
    expect(tier('coarse_agg', 'la_abrasion_pct')).toBe('optional');
  });
  it('cement: SG evaluates; C3A and alkali are design fields', () => {
    expect(tier('cement', 'sg')).toBe('evaluate');
    expect(tier('cement', 'c3a_pct')).toBe('design');
    expect(tier('cement', 'alkali_na2o_eq_pct')).toBe('design');
  });
  it('admixture and water minimums', () => {
    expect(tier('admixture', 'solids_pct')).toBe('evaluate');
    expect(tier('admixture', 'max_dosage_pct')).toBe('design');
    expect(tier('water', 'chloride_mg_l')).toBe('design');
  });
});

describe('local drafts', () => {
  beforeEach(() => window.localStorage.clear());
  const draft = { values: { sg_ssd: '2.6' }, gradation: [], table: [], extra: {} };
  it('saves per user and target, and clears', () => {
    saveDraft('u1', 'new', draft);
    expect(loadDraft('u1', 'new')?.values).toEqual({ sg_ssd: '2.6' });
    expect(loadDraft('u2', 'new')).toBeNull();
    clearDraft('u1', 'new');
    expect(loadDraft('u1', 'new')).toBeNull();
  });
  it('sign-out removes every draft and nothing else', () => {
    saveDraft('u1', 'a', draft);
    saveDraft('u2', 'b', draft);
    window.localStorage.setItem('khalta.plant', 'x');
    clearAllDrafts();
    expect(loadDraft('u1', 'a')).toBeNull();
    expect(loadDraft('u2', 'b')).toBeNull();
    expect(window.localStorage.getItem('khalta.plant')).toBe('x');
  });
});

describe('Sparkline', () => {
  it('has a text alternative and is LTR', () => {
    const { container } = render(
      <Sparkline values={[2.6, 2.62, 2.65]} label="SG" format={(n) => n.toFixed(2)} />,
    );
    expect(screen.getByRole('img').getAttribute('aria-label')).toMatch(/2\.60.*2\.65/);
    expect(container.firstElementChild?.getAttribute('dir')).toBe('ltr');
  });
  it('says so when there is only one test', () => {
    render(<Sparkline values={[2.6]} label="SG" format={String} />);
    expect(screen.queryByRole('img')).toBeNull();
  });
});
