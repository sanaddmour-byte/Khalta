import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PNG } from 'pngjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  closePdfBrowser,
  combinedGrading,
  renderPdf,
  submittalHtml,
  type SubmittalData,
} from '../src/submittal/render';

// A fixed, hand-made record (SYNTHETIC): no database, no clock. The Arabic page is rasterised and compared with a
// stored baseline, so a broken font, reversed bidi or lost shaping shows up as a visual difference.
const DATA: SubmittalData = {
  design: {
    id: '11111111-2222-4333-8444-555555555555',
    code: 'AMM01-C30-S2-19-SU-v1',
    version: 1,
    status: 'trial_candidate',
    name: 'SYNTHETIC C30',
  },
  plant: { nameEn: 'Amman plant 01', nameAr: 'مصنع عمّان ١' },
  letterhead: {
    nameEn: 'Example Ready Mix Co.',
    nameAr: 'شركة المثال للخرسانة الجاهزة',
    addressEn: 'Amman, Jordan',
    addressAr: 'عمّان، الأردن',
    logoDataUrl: null,
  },
  requirements: {
    fcMpa: 30,
    basis: 'cylinder',
    testAgeDays: 28,
    exposure: ['F0', 'S0', 'W0', 'C1'],
    slumpMm: 100,
    nmasMm: 19,
    pumpable: true,
  },
  lines: [
    {
      materialId: 'c',
      nameEn: 'Cement CEM I 42.5',
      nameAr: 'إسمنت بورتلاندي',
      category: 'cement',
      kg: 300,
      testSource: 'supplier_datasheet',
      testedAt: '2026-08-01',
      testVersion: 1,
      declared: false,
      sieve: null,
    },
    {
      materialId: 's',
      nameEn: 'Crushed sand',
      nameAr: 'رمل مكسر',
      category: 'fine_agg',
      kg: 800,
      testSource: 'lab_report',
      testedAt: '2026-08-02',
      testVersion: 2,
      declared: true,
      sieve: [
        { sieve_mm: 9.5, passing_pct: 100 },
        { sieve_mm: 4.75, passing_pct: 95 },
        { sieve_mm: 0.6, passing_pct: 30 },
        { sieve_mm: 0.15, passing_pct: 12 },
      ],
    },
    {
      materialId: 'g',
      nameEn: 'Gravel 20 mm',
      nameAr: 'حصى ٢٠ ملم',
      category: 'coarse_agg',
      kg: 1000,
      testSource: 'lab_report',
      testedAt: '2026-08-02',
      testVersion: 1,
      declared: false,
      sieve: [
        { sieve_mm: 9.5, passing_pct: 40 },
        { sieve_mm: 4.75, passing_pct: 8 },
        { sieve_mm: 0.6, passing_pct: 1 },
        { sieve_mm: 0.15, passing_pct: 0 },
      ],
    },
    {
      materialId: 'w',
      nameEn: 'Water',
      nameAr: 'ماء',
      category: 'water',
      kg: 180,
      testSource: null,
      testedAt: null,
      testVersion: null,
      declared: false,
      sieve: null,
    },
  ],
  batch: null,
  report: null,
  trial: { testAgeDays: 28, batches: [], results: [] },
  approvals: [],
  externalApprovalRef: null,
};
const PRINTED = new Date('2026-10-02T09:00:00Z');
const BASE = 'https://khalta.example';
const dir = path.join(import.meta.dirname, 'snapshots');
const poppler = (() => {
  try {
    execFileSync('pdftoppm', ['-v'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

function firstPage(pdf: Buffer): PNG {
  const tmp = mkdtempSync(path.join(tmpdir(), 'khalta-snap-'));
  writeFileSync(path.join(tmp, 'a.pdf'), pdf);
  execFileSync('pdftoppm', [
    '-r',
    '60',
    '-png',
    '-f',
    '1',
    '-l',
    '1',
    path.join(tmp, 'a.pdf'),
    path.join(tmp, 'p'),
  ]);
  const file = execFileSync('sh', ['-c', `ls ${tmp}/p*.png`], { encoding: 'utf8' }).trim();
  return PNG.sync.read(readFileSync(file));
}
/** Mean absolute channel difference (0–255); anti-aliasing noise stays far below the threshold. */
function diff(a: PNG, b: PNG): number {
  if (a.width !== b.width || a.height !== b.height) return 255;
  let sum = 0;
  for (let i = 0; i < a.data.length; i++) sum += Math.abs(a.data[i]! - b.data[i]!);
  return sum / a.data.length;
}

beforeAll(() => {
  if (!process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE']) {
    const exe = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
    if (existsSync(exe)) process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] = exe;
  }
});
afterAll(closePdfBrowser);

describe('submittal HTML', () => {
  it('watermark follows the state and has no off switch; never any cost', async () => {
    for (const [status, mark] of [
      ['draft', 'NOT APPROVED'],
      ['trial_passed', 'NOT APPROVED'],
      ['superseded', 'SUPERSEDED'],
      ['retired', 'RETIRED'],
    ] as const) {
      const html = await submittalHtml(
        { ...DATA, design: { ...DATA.design, status } },
        'en',
        BASE,
        PRINTED,
      );
      expect(html, status).toContain(mark);
    }
    for (const status of ['approved', 'in_production'])
      expect(
        await submittalHtml({ ...DATA, design: { ...DATA.design, status } }, 'en', BASE, PRINTED),
      ).not.toContain('wm"');
    const html = await submittalHtml(DATA, 'both', BASE, PRINTED);
    // the page text only: the embedded fonts and QR are base64 and could contain any letters
    const visible = html.replace(/<style>[\s\S]*?<\/style>/, '').replace(/data:[^"')]+/g, '');
    expect(visible).not.toMatch(/JOD|cost|price/i);
    expect(html).toContain('dir="rtl"');
    expect(html).toContain('مستند اعتماد الخلطة');
    expect(html).toContain('Mix design submittal');
    expect(html).toContain('User-declared material values');
  });
  it('escapes material names and builds the combined grading from proportions', async () => {
    const html = await submittalHtml(
      { ...DATA, lines: [{ ...DATA.lines[0]!, nameEn: '<script>x</script>' }] },
      'en',
      BASE,
      PRINTED,
    );
    expect(html).not.toContain('<script>x');
    const g = combinedGrading(DATA.lines);
    // 4.75 mm: (800×95 + 1000×8) / 1800 = 46.67
    expect(g.find((p) => p.sieve_mm === 4.75)!.passing_pct).toBeCloseTo(46.667, 2);
    expect(g.map((p) => p.sieve_mm)).toEqual([9.5, 4.75, 0.6, 0.15]);
  });
});

describe.skipIf(!poppler)('submittal PDF visual snapshot', () => {
  for (const lang of ['ar', 'both', 'en'] as const) {
    it(`page 1 (${lang}) matches the stored baseline`, async () => {
      const pdf = await renderPdf(await submittalHtml(DATA, lang, BASE, PRINTED));
      const got = firstPage(pdf);
      const file = path.join(dir, `submittal-${lang}.png`);
      if (process.env['UPDATE_SNAPSHOTS'] || !existsSync(file)) {
        mkdirSync(dir, { recursive: true });
        writeFileSync(file, PNG.sync.write(got));
        return;
      }
      expect(diff(got, PNG.sync.read(readFileSync(file)))).toBeLessThan(1.0);
    });
  }
});
