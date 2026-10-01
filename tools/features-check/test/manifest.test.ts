import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { approvedFor, parseManifest } from '../src/index';

const real = readFileSync(join(import.meta.dirname, '../../../docs/spec/06-features.md'), 'utf8');

describe('the real manifest', () => {
  const { features, errors } = parseManifest(real);
  it('is valid', () => expect(errors).toEqual([]));
  it('has the 31 seeded features with unique ids', () => {
    expect(features).toHaveLength(31);
    expect(new Set(features.map((f) => f.id)).size).toBe(31);
  });
  it('lists the M0.4 features in priority order', () => {
    expect(approvedFor(features, 'M0.4').map((f) => f.id)).toEqual(['F-003', 'F-004']);
    expect(approvedFor(features, 'M3.1').map((f) => f.id)).toEqual([
      'F-014',
      'F-015',
      'F-017',
      'F-016',
    ]);
  });
});

const row = (id: string, p = 'Must', m = 'M1.1', s = 'approved') =>
  `| ${id} | Thing | ${p} | ${m} | ${s} |`;

describe('validation', () => {
  it('flags bad ids, priorities, milestones, statuses and duplicates', () => {
    const md = [
      row('F-1'),
      row('F-002', 'Urgent'),
      row('F-003', 'Must', '1.1'),
      row('F-004', 'Must', 'M1.1', 'maybe'),
      row('F-005'),
      row('F-005'),
    ].join('\n');
    const { errors } = parseManifest(md);
    expect(errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining('bad feature id "F-1"'),
        expect.stringContaining('invalid priority "Urgent"'),
        expect.stringContaining('invalid milestone "1.1"'),
        expect.stringContaining('invalid status "maybe"'),
        expect.stringContaining('duplicate feature id F-005'),
      ]),
    );
  });

  it('flags a detail entry that disagrees with the table or has no table row', () => {
    const md = `${row('F-001')}\n\n### F-001 — Thing\n- Status: done · Priority: Must · Milestone: M1.1\n- Acceptance criteria:\n  - x\n\n### F-009 — Ghost\n- Status: approved · Priority: Must · Milestone: M1.1\n`;
    const { errors } = parseManifest(md);
    expect(errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining('F-001: status in detail (done) differs from table (approved)'),
        expect.stringContaining('F-009 has no row in the table'),
      ]),
    );
  });

  it('rejects an empty manifest and wrong column counts', () => {
    expect(parseManifest('nothing here').errors).toContain(
      'no features found in the manifest table',
    );
    expect(parseManifest('| F-001 | only | three |').errors[0]).toMatch(/expected 5 columns/);
  });

  it('only returns approved/building features for the milestone', () => {
    const { features } = parseManifest(
      [
        row('F-001', 'Should'),
        row('F-002', 'Must'),
        row('F-003', 'Must', 'M1.1', 'done'),
        row('F-004', 'Must', 'M1.1', 'proposed'),
        row('F-005', 'Must', 'M2.1'),
      ].join('\n'),
    );
    expect(approvedFor(features, 'M1.1').map((f) => f.id)).toEqual(['F-002', 'F-001']);
  });
});
