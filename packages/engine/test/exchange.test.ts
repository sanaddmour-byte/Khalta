import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  BATCH_HEADER,
  BATCH_SCHEMA,
  batchCsv,
  BOM,
  DESIGNS_HEADER,
  DESIGNS_SCHEMA,
  designsCsv,
  detectMapping,
  neutralise,
  num,
  parseLegacyRows,
  text,
  toCsv,
  type ExportBatch,
  type ExportDesign,
} from '../src/index';

// An independent RFC 4180 reader (the contract's reference parser): BOM, CRLF, quotes, doubled quotes.
function parse(csv: string): string[][] {
  expect(csv.startsWith(BOM)).toBe(true);
  const s = csv.slice(1);
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let q = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (q) {
      if (c === '"' && s[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') {
      row.push(cell);
      cell = '';
    } else if (c === '\r' && s[i + 1] === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      i++;
    } else cell += c;
  }
  expect(cell).toBe('');
  expect(row).toEqual([]);
  return rows;
}

const design = (over: Partial<ExportDesign> = {}): ExportDesign => ({
  code: 'AMM01-C30',
  name: 'C30 pump, "plain"',
  plantCode: 'AMM-01',
  version: 2,
  status: 'approved',
  approvedAt: '2026-10-01T08:00:00.000Z',
  approvedBy: 'QC Manager Two',
  designHash: 'a'.repeat(64),
  rulesetMode: 'ACI',
  avgMonthlyVolumeM3: '1500.00',
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
      lineNo: 1,
      materialId: 'm1',
      materialName: 'إسمنت (تجريبي)',
      category: 'cement',
      kgPerM3: '360.000',
    },
    { lineNo: 2, materialId: 'm2', materialName: 'ماء', category: 'water', kgPerM3: '175.000' },
    {
      lineNo: 3,
      materialId: 'm3',
      materialName: 'رمل\nمغسول',
      category: 'fine_agg',
      kgPerM3: '820.500',
    },
    {
      lineNo: 4,
      materialId: 'm4',
      materialName: 'Coarse 20 mm',
      category: 'coarse_agg',
      kgPerM3: '1000.000',
    },
  ],
  ...over,
});

describe('writer', () => {
  it('writes BOM, CRLF, quotes only what needs it, and keeps Arabic and line breaks', () => {
    const rows = parse(designsCsv([design()]));
    expect(rows[0]).toEqual([...DESIGNS_HEADER]);
    expect(rows).toHaveLength(5);
    expect(rows[1]![2]).toBe('C30 pump, "plain"');
    expect(rows[3]![10]).toBe('رمل\nمغسول');
    expect(designsCsv([design()]).includes('\r\n')).toBe(true);
    expect(designsCsv([design()]).split('\r\n').at(-1)).toBe('');
  });
  it('neutralises formula starts in text and leaves numbers alone', () => {
    for (const bad of ['=SUM(A1)', '+1', '-2+3', '@cmd', '\tx', '\rx'])
      expect(neutralise(bad)).toBe(`'${bad}`);
    expect(neutralise('-12.5')).toBe('-12.5');
    expect(neutralise('plain')).toBe('plain');
    expect(text('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    const hostile = parse(designsCsv([design({ name: '=1+1', approvedBy: '@evil' })]));
    expect(hostile[1]![2]).toBe("'=1+1");
    expect(hostile[1]![21]).toBe("'@evil");
  });
  it('writes numbers exactly as given and refuses anything that is not a plain decimal', () => {
    expect(num('360.000')).toBe('360.000');
    expect(num('-3.25')).toBe('-3.25');
    expect(num(null)).toBe('');
    expect(() => num('1e-7')).toThrow();
    expect(() => num('1,5')).toThrow();
    expect(() => toCsv(['a', 'b'], [['1']])).toThrow();
  });
  it('is identical across runs and independent of input order', () => {
    const a = design();
    const b = design({ code: 'AMM01-C25', lines: [...a.lines].reverse() });
    expect(designsCsv([a, b])).toBe(designsCsv([b, a]));
    expect(designsCsv([a, b])).toBe(designsCsv([a, b]));
  });
});

describe('the contract is frozen', () => {
  it('designs header', () => {
    expect(DESIGNS_HEADER.join(',')).toBe(
      'design_code,plant_code,design_name,fc_mpa,strength_basis,test_age_days,exposure_classes,slump_mm,nmas_mm,pumpable,material_name,material_category,quantity,unit,approval_reference,currently_in_production,avg_monthly_volume_m3,schema,version,status,approved_at,approved_by,design_hash,ruleset_mode,material_id,line_no,quantity_basis',
    );
    expect(DESIGNS_SCHEMA).toBe('khalta.designs.v1');
  });
  it('batch-weights header', () => {
    expect(BATCH_HEADER.join(',')).toBe(
      'schema,batch_instance_id,design_code,design_version,plant_code,kind,created_at,created_by,check_verdict,check_version,material_id,material_name,material_category,line_no,kg_ssd,kg_oven_dry,kg_batch,free_water_kg,solution_water_kg,total_moisture_pct,absorption_pct,moisture_measured_at,design_water_kg,batch_water_kg,design_hash,basis',
    );
    expect(BATCH_SCHEMA).toBe('khalta.batch-weights.v1');
  });
  it('no cost, price, margin or saving column exists in either file', () => {
    for (const h of [...DESIGNS_HEADER, ...BATCH_HEADER])
      expect(h).not.toMatch(/cost|price|margin|saving|jod|tender|discount/i);
  });
});

describe('the reference parser rebuilds each design exactly', () => {
  it('every line, requirement and hash survives (property)', () => {
    const line = fc.record({
      materialName: fc.string({ minLength: 1, maxLength: 20 }),
      kg: fc.integer({ min: 1, max: 2_000_000 }).map((v) => (v / 1000).toFixed(3)),
    });
    fc.assert(
      fc.property(
        fc.array(line, { minLength: 1, maxLength: 8 }),
        fc.string({ maxLength: 30 }),
        (ls, name) => {
          const d = design({
            name,
            lines: ls.map((l, i) => ({
              lineNo: i + 1,
              materialId: `id${i}`,
              materialName: l.materialName,
              category: 'coarse_agg',
              kgPerM3: l.kg,
            })),
          });
          const rows = parse(designsCsv([d]));
          expect(rows).toHaveLength(ls.length + 1);
          rows.slice(1).forEach((r, i) => {
            const orig = ls[i]!;
            expect(r[10]).toBe(neutralise(orig.materialName));
            expect(r[12]).toBe(orig.kg);
            expect(r[22]).toBe(d.designHash);
            expect(r[2]).toBe(neutralise(name));
          });
        },
      ),
    );
  });
  it('the legacy importer reads the shared columns (and treats the file as a legacy import)', () => {
    const rows = parse(designsCsv([design()]));
    const { mapping, missing } = detectMapping(rows[0]!);
    expect(missing).toEqual([]);
    const out = parseLegacyRows(rows.slice(1), mapping);
    expect(out.fileErrors).toEqual([]);
    expect(out.designs).toHaveLength(1);
    const d = out.designs[0]!;
    expect(d.code).toBe('AMM01-C30');
    expect(d.lines.map((l) => l.materialName)).toContain('رمل\nمغسول');
  });
});

describe('batch weights', () => {
  const batch = (): ExportBatch => ({
    id: 'b1',
    designCode: 'AMM01-C30',
    designVersion: 2,
    plantCode: 'AMM-01',
    kind: 'production',
    createdAt: '2026-10-02T06:00:00.000Z',
    createdBy: 'Plant Manager',
    checkVerdict: 'pass',
    checkVersion: 'validator-1',
    designHash: 'b'.repeat(64),
    designWaterKg: 175,
    batchWaterKg: 160.25,
    lines: [
      {
        lineNo: 1,
        materialId: 'm3',
        materialName: 'رمل',
        category: 'fine_agg',
        kgSsd: 820.5,
        kgOvenDry: 800,
        kgBatch: 836,
        freeWaterKg: -3.25,
        solutionWaterKg: null,
        totalMoisturePct: 4.5,
        absorptionPct: 2.56,
        moistureMeasuredAt: '2026-10-02T05:00:00.000Z',
      },
      {
        lineNo: 2,
        materialId: 'm2',
        materialName: 'ماء',
        category: 'water',
        kgSsd: 175,
        kgOvenDry: null,
        kgBatch: 160.25,
        freeWaterKg: null,
        solutionWaterKg: null,
        totalMoisturePct: null,
        absorptionPct: null,
        moistureMeasuredAt: null,
      },
    ],
  });
  it('writes every term as stored, with empty cells for what does not apply', () => {
    const rows = parse(batchCsv([batch()]));
    expect(rows[0]).toEqual([...BATCH_HEADER]);
    expect(rows[1]![17]).toBe('-3.25');
    expect(rows[1]![14]).toBe('820.5');
    expect(rows[2]![15]).toBe('');
    expect(rows[2]![16]).toBe('160.25');
    expect(rows[1]![8]).toBe('pass');
    expect(rows[1]![25]).toBe('kg per m3 of concrete');
  });
});
