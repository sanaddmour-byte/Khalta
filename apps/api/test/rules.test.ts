import { schema } from '@khalta/db';
import { loadSeeds } from '@khalta/rules/loader';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { syncRules } from '../src/rules/service';
import { createTestEnv, type TestEnv } from './helpers';

let env: TestEnv;
let admin: Awaited<ReturnType<TestEnv['login']>>;
let qcm: Awaited<ReturnType<TestEnv['login']>>;
let qcm2: Awaited<ReturnType<TestEnv['login']>>;
let qce: Awaited<ReturnType<TestEnv['login']>>;
let viewer: Awaited<ReturnType<TestEnv['login']>>;
const seeds = loadSeeds();

beforeAll(async () => {
  env = await createTestEnv({}, { seedRules: true });
  admin = await env.login((await env.seedUser('admin')).email);
  qcm = await env.login((await env.seedUser('qc_manager')).email);
  qcm2 = await env.login((await env.seedUser('qc_manager')).email);
  qce = await env.login((await env.seedUser('qc_engineer')).email);
  viewer = await env.login((await env.seedUser('viewer')).email);
});
afterAll(() => env.close());

type Dto = {
  id: string;
  ruleset: string;
  key: string;
  status: string;
  verified: boolean;
  version: number;
  value: unknown;
  kind: string;
  origin: string;
};
const rule = async (ruleset: string, key: string): Promise<Dto> => {
  const res = await qcm.get(`/api/rules?ruleset=${ruleset}&q=${encodeURIComponent(key)}`);
  const found = (res.body.rules as Dto[]).find((r) => r.key === key);
  if (!found) throw new Error(`no rule ${ruleset}:${key}`);
  return found;
};
const csv = (
  rows: string[][],
  header = [
    'rule_key',
    'value',
    'units',
    'clause_ref',
    'requirement_class',
    'note_ar',
    'note_en',
    'value_json',
  ],
) =>
  [
    header.join(','),
    ...rows.map((r) =>
      r.map((c) => (/[,"\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(','),
    ),
  ].join('\n');

describe('seed sync', () => {
  it('loaded every seed rule as version 1, unverified, origin seed', async () => {
    const rows = await env.db.select().from(schema.rules);
    expect(rows).toHaveLength(seeds.rules.length);
    expect(
      rows.every(
        (r) =>
          r.version === 1 &&
          r.isCurrent &&
          !r.verified &&
          r.origin === 'seed' &&
          r.createdBy === null,
      ),
    ).toBe(true);
    expect(rows.filter((r) => r.verified)).toEqual([]);
  });

  it('is idempotent and reports drift without overwriting database content', async () => {
    const run = () =>
      env.db.transaction(async (tx) =>
        syncRules(tx, { record: async () => {} }, env.tenantId, seeds),
      );
    expect(await run()).toEqual({ inserted: 0, drift: [] });
    const w = await rule('ACI', 'durability.S2.max_wcm');
    await qcm.patch(`/api/rules/${w.id}/value`).send({ value: 0.44, reason: 'transcription fix' });
    const again = await run();
    expect(again.inserted).toBe(0);
    expect(again.drift).toEqual([{ ruleset: 'ACI', key: 'durability.S2.max_wcm' }]);
    expect((await rule('ACI', 'durability.S2.max_wcm')).value).toBe(0.44); // the database wins
    // restore for the other tests
    const cur = await rule('ACI', 'durability.S2.max_wcm');
    await qcm
      .patch(`/api/rules/${cur.id}/value`)
      .send({ value: 0.45, reason: 'restore the spec value' });
  });
});

describe('reading rules', () => {
  it('needs rules.read: admin, QC manager and QC engineer only', async () => {
    expect((await viewer.get('/api/rules')).status).toBe(403);
    expect(
      (await (await env.login((await env.seedUser('sales')).email)).get('/api/rules')).status,
    ).toBe(403);
    for (const a of [admin, qcm, qce]) expect((await a.get('/api/rules')).status).toBe(200);
  });

  it('lists ACI, JS, shared and engineering rules with a summary that counts honestly', async () => {
    const res = await qce.get('/api/rules');
    const s = res.body.summary.byRuleset;
    expect(Object.keys(s).sort()).toEqual(['ACI', 'ENGINEERING', 'JS', 'SHARED']);
    expect(s.JS.verified).toBe(0);
    expect(s.JS.missing).toBeGreaterThan(40); // the skeleton is empty
    expect(s.ACI.verified).toBe(0);
    expect(s.ACI.unverified).toBeGreaterThan(40);
    expect(s.ACI.missing).toBe(4); // grading limits (2) and the air-entrained design aids (2) are not on file
  });

  it('filters by ruleset, class, status and free text (English, Arabic and clause)', async () => {
    const aci = await qce.get('/api/rules?ruleset=ACI&status=missing');
    expect((aci.body.rules as Dto[]).map((r) => r.key).sort()).toEqual([
      'grading.coarse.limits',
      'grading.fine.limits',
      'prop.water.ae',
      'prop.wc_strength.ae',
    ]);
    expect(
      (await qce.get('/api/rules?requirementClass=DESIGN_AID&ruleset=ACI')).body.rules.length,
    ).toBe(6);
    expect((await qce.get('/api/rules?q=19.3.2.1')).body.rules.length).toBeGreaterThan(30);
    expect(
      (await qce.get('/api/rules?q=' + encodeURIComponent('الكبريتات'))).body.rules.length,
    ).toBeGreaterThan(0);
    expect((await qce.get('/api/rules?status=bogus')).status).toBe(400);
  });

  it('informational rows are never reported as missing', async () => {
    const cover = await rule('ACI', 'durability.C2.min_cover');
    expect(cover.status).toBe('info');
  });

  it('shows one rule with its history, and 404s for unknown or foreign ids', async () => {
    const w = await rule('ACI', 'durability.S1.max_wcm');
    const res = await qce.get(`/api/rules/${w.id}`);
    expect(res.status).toBe(200);
    expect(res.body.rule).toMatchObject({
      key: 'durability.S1.max_wcm',
      value: 0.5,
      clauseRef: 'ACI 318-19 Table 19.3.2.1',
      usedByDesigns: 0,
    });
    expect(res.body.versions).toHaveLength(1);
    expect((await qce.get('/api/rules/00000000-0000-4000-8000-0000000000aa')).status).toBe(404);
    expect((await qce.get('/api/rules/not-a-uuid')).status).toBe(400);
  });
});

describe('verification', () => {
  it('only a QC manager can verify, with a typed note, and it is recorded and audited', async () => {
    const w = await rule('ACI', 'durability.F1.max_wcm');
    expect(
      (await qce.post(`/api/rules/${w.id}/verify`).send({ note: 'checked against ACI 318-19' }))
        .status,
    ).toBe(403);
    expect(
      (await admin.post(`/api/rules/${w.id}/verify`).send({ note: 'checked against ACI 318-19' }))
        .status,
    ).toBe(403);
    expect((await qcm.post(`/api/rules/${w.id}/verify`).send({ note: 'no' })).status).toBe(400); // note too short
    expect((await qcm.post(`/api/rules/${w.id}/verify`).send({})).status).toBe(400);
    const before = (await env.auditRows()).length;
    const ok = await qcm
      .post(`/api/rules/${w.id}/verify`)
      .send({ note: 'Checked against licensed ACI 318-19 T19.3.2.1 (F1)' });
    expect(ok.status).toBe(200);
    expect((await rule('ACI', 'durability.F1.max_wcm')).status).toBe('verified');
    const detail = await qcm.get(`/api/rules/${w.id}`);
    expect(detail.body.verifications[0]).toMatchObject({
      note: 'Checked against licensed ACI 318-19 T19.3.2.1 (F1)',
    });
    const audit = (await env.auditRows()).slice(before);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ action: 'rule.verify', entityType: 'rule', entityId: w.id });
    expect(audit[0]!.after).toMatchObject({ verified: true });
  });

  it('refuses to verify twice, or to verify a rule that has no value on file', async () => {
    const w = await rule('ACI', 'durability.F1.max_wcm');
    expect(
      (await qcm.post(`/api/rules/${w.id}/verify`).send({ note: 'second signature attempt' }))
        .status,
    ).toBe(409);
    const empty = await rule('JS', 'durability.S2.max_wcm');
    const res = await qcm
      .post(`/api/rules/${empty.id}/verify`)
      .send({ note: 'nothing to verify here' });
    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/no value on file/);
  });

  it('four-eyes: whoever changed a value cannot verify it; another QC manager can', async () => {
    const w = await rule('ACI', 'durability.F2.max_wcm');
    expect(
      (
        await qcm
          .patch(`/api/rules/${w.id}/value`)
          .send({ clause_ref: 'ACI 318-19 T19.3.2.1 (F2) rechecked', reason: 'clause wording' })
      ).status,
    ).toBe(200);
    const next = await rule('ACI', 'durability.F2.max_wcm');
    const mine = await qcm
      .post(`/api/rules/${next.id}/verify`)
      .send({ note: 'I will sign my own change' });
    expect(mine.status).toBe(403);
    expect(mine.body.error.message).toMatch(/four-eyes/);
    expect(
      (
        await qcm2
          .post(`/api/rules/${next.id}/verify`)
          .send({ note: 'independent check against the book' })
      ).status,
    ).toBe(200);
  });

  it('a verified rule becomes unverified when its value is corrected, and the old verification stays in history', async () => {
    const w = await rule('ACI', 'durability.F1.max_wcm');
    expect(w.verified).toBe(true);
    const edit = await qcm
      .patch(`/api/rules/${w.id}/value`)
      .send({ value: 0.54, reason: 'source says 0.54' });
    expect(edit.status).toBe(200);
    expect(edit.body).toMatchObject({ version: 2, verified: false, value: 0.54, origin: 'ui' });
    const cur = await rule('ACI', 'durability.F1.max_wcm');
    expect([cur.version, cur.status]).toEqual([2, 'unverified']);
    const detail = await qcm.get(`/api/rules/${cur.id}`);
    expect(
      detail.body.versions.map((v: { version: number; isCurrent: boolean; verified: boolean }) => [
        v.version,
        v.isCurrent,
        v.verified,
      ]),
    ).toEqual([
      [2, true, false],
      [1, false, true],
    ]);
    expect(detail.body.verifications).toHaveLength(1); // the v1 signature is not lost
    await qcm.patch(`/api/rules/${cur.id}/value`).send({ value: 0.55, reason: 'restore' });
  });
});

describe('correcting values', () => {
  it('needs import.run (admin, QC manager), a reason, and a value of the right shape', async () => {
    const w = await rule('ACI', 'durability.W2.max_wcm');
    expect(
      (await qce.patch(`/api/rules/${w.id}/value`).send({ value: 0.5, reason: 'try' })).status,
    ).toBe(403);
    expect((await qcm.patch(`/api/rules/${w.id}/value`).send({ value: 0.49 })).status).toBe(400); // no reason
    expect(
      (await qcm.patch(`/api/rules/${w.id}/value`).send({ value: 'high', reason: 'wrong type' }))
        .status,
    ).toBe(422);
    expect((await qcm.patch(`/api/rules/${w.id}/value`).send({ reason: 'nothing' })).status).toBe(
      400,
    );
    expect(
      (await qcm.patch(`/api/rules/${w.id}/value`).send({ value: 0.5, reason: 'same value' }))
        .status,
    ).toBe(409);
    expect(
      (
        await qcm
          .patch(`/api/rules/${w.id}/value`)

          .send({
            definition: { cols: { name: 'x', values: [1] }, data: [[1]], interpolation: 'linear' },
            reason: 'not a table',
          })
      ).status,
    ).toBe(409);
  });

  it('a value cannot be blanked ("not on file" only comes from the seed files)', async () => {
    const w = await rule('ACI', 'durability.W2.max_wcm');
    const res = await qcm
      .patch(`/api/rules/${w.id}/value`)
      .send({ value: null, reason: 'try to clear it' });
    expect(res.status).toBe(400);
    expect((await rule('ACI', 'durability.W2.max_wcm')).version).toBe(w.version);
  });

  it('tables take a validated definition, not a value', async () => {
    const t = await rule('ACI', 'prop.wc_strength.non_ae');
    expect(
      (await qcm.patch(`/api/rules/${t.id}/value`).send({ value: 1, reason: 'wrong field' }))
        .status,
    ).toBe(409);
    const bad = await qcm.patch(`/api/rules/${t.id}/value`).send({
      definition: {
        cols: { name: 'x', values: [2, 1] },
        data: [[1, 2]],
        interpolation: 'linear',
      },
      reason: 'bad table',
    });
    expect(bad.status).toBe(400);
    const good = await qcm.patch(`/api/rules/${t.id}/value`).send({
      definition: {
        cols: { name: 'fcr_mpa', values: [15, 20] },
        data: [[0.79, 0.69]],
        interpolation: 'linear',
      },
      reason: 'shorter table',
    });
    expect(good.status).toBe(200);
    const cur = await rule('ACI', 'prop.wc_strength.non_ae');
    await qcm.patch(`/api/rules/${cur.id}/value`).send({
      definition: seeds.rules.find((r) => r.key === 'prop.wc_strength.non_ae')!.definition,
      reason: 'restore the full table',
    });
  });

  it('is audited with before and after, and a rule can be filled in from "not on file"', async () => {
    const j = await rule('JS', 'durability.S1.max_wcm');
    const before = (await env.auditRows()).length;
    const res = await admin.patch(`/api/rules/${j.id}/value`).send({
      value: 0.5,
      clause_ref: 'JSC-2022 §7.3.2',
      reason: 'from the Jordanian code, Table 7.3',
    });
    expect(res.status).toBe(200);
    const [row] = (await env.auditRows()).slice(before);
    expect(row).toMatchObject({ action: 'rule.update' });
    expect(row!.before).toMatchObject({ value: null, version: 1 });
    expect(row!.after).toMatchObject({
      value: 0.5,
      version: 2,
      clause_ref: 'JSC-2022 §7.3.2',
      verified: false,
    });
    expect((await rule('JS', 'durability.S1.max_wcm')).status).toBe('unverified');
  });
});

describe('database guarantees', () => {
  it('rule content is immutable in place; only bookkeeping may change', async () => {
    const w = await rule('ACI', 'durability.S2.min_fc');
    const q = (sql: string) => env.pool.query(sql, [w.id]);
    await expect(q(`UPDATE rules SET value = '99' WHERE id = $1`)).rejects.toThrow(/immutable/);
    await expect(q(`UPDATE rules SET clause_ref = 'x' WHERE id = $1`)).rejects.toThrow(/immutable/);
    await expect(q(`UPDATE rules SET units = 'ppm' WHERE id = $1`)).rejects.toThrow(/immutable/);
    await expect(q(`UPDATE rules SET key = 'other' WHERE id = $1`)).rejects.toThrow(/immutable/);
    await expect(q(`DELETE FROM rules WHERE id = $1`)).rejects.toThrow(/hard delete/);
  });

  it('verification history is append-only', async () => {
    const q = (s: string) => env.pool.query(s);
    await expect(q(`UPDATE rule_verifications SET note = 'edited'`)).rejects.toThrow(/append-only/);
    await expect(q(`DELETE FROM rule_verifications`)).rejects.toThrow(/append-only/);
    await expect(q(`TRUNCATE rule_verifications`)).rejects.toThrow(/append-only/);
  });

  it('nothing without a value can be marked verified', async () => {
    const j = await rule('JS', 'air.tolerance_pct');
    await expect(
      env.pool.query(`UPDATE rules SET verified = true WHERE id = $1`, [j.id]),
    ).rejects.toThrow(); // (PostgreSQL may fail while formatting the Arabic row detail)
    expect((await rule('JS', 'air.tolerance_pct')).verified).toBe(false);
  });

  it('at most one current version per rule', async () => {
    await expect(
      env.pool
        .query(`INSERT INTO rules (tenant_id, ruleset_id, key, requirement, version, is_current, kind, requirement_class, units, clause_ref, origin)
        SELECT tenant_id, ruleset_id, key, requirement, 99, true, kind, requirement_class, units, clause_ref, 'ui' FROM rules WHERE key = 'durability.S2.min_fc' AND is_current`),
    ).rejects.toThrow(/rules_current_uq/);
  });
});

describe('CSV import of Jordanian values', () => {
  const GOOD = [
    [
      'durability.S2.max_wcm',
      '0.45',
      'ratio',
      'JSC-2022 §7.3.1',
      'CODE_HARD',
      'أقصى نسبة ماء إلى مواد إسمنتية',
      'Max w/cm for S2',
      '',
    ],
    ['durability.S2.min_fc', '31', 'MPa', 'JSC-2022 §7.3.1', 'CODE_HARD', '', '', ''],
    ['durability.S2.cacl2_prohibited', 'true', 'none', 'JSC-2022 §7.3.4', 'CODE_HARD', '', '', ''],
    ['durability.S2.sulfate_cement', 'high', 'none', 'JSC-2022 §7.3.2', 'CODE_HARD', '', '', ''],
    ['nmas.max_fraction.slab_depth', '1/3', 'fraction', 'JSC-2022 §6.1', 'CODE_HARD', '', '', ''],
  ];
  const preview = (text: string, who = qcm) =>
    who.post('/api/rules/import/preview').send({ csv: text, filename: 'js-rule-values.csv' });
  const rows = (res: { body: { rows: { ruleKey: string; status: string; errors: string[] }[] } }) =>
    Object.fromEntries(res.body.rows.map((r) => [r.ruleKey, r]));

  it('validates without writing: unknown keys, units, classes, placeholders, numbers, duplicates', async () => {
    const before = await env.db.select().from(schema.rules);
    const res = await preview(
      csv([
        ['nope.key', '1', 'ratio', 'JSC §1', 'CODE_HARD', '', '', ''],
        ['durability.S3.opt1.max_wcm', '0.45', 'MPa', 'JSC §1', 'CODE_HARD', '', '', ''], // wrong unit
        ['durability.S3.opt2.max_wcm', '0.40', 'ratio', 'JSC §1', 'DESIGN_AID', '', '', ''], // wrong class
        ['durability.W2.max_wcm', '0.50', 'ratio', 'JSC-2022 §TBD', 'CODE_HARD', '', '', ''], // placeholder clause
        ['durability.F3.max_wcm', 'forty', 'ratio', 'JSC §1', 'CODE_HARD', '', '', ''], // not a number
        ['durability.F3.min_fc', '35', 'MPa', 'JSC §1', 'CODE_HARD', '', '', ''],
        ['durability.F3.min_fc', '36', 'MPa', 'JSC §1', 'CODE_HARD', '', '', ''], // duplicate
        ['air.F1.target_pct', '6', '%', 'JSC §2', 'CODE_HARD', '', '', ''], // table needs value_json
      ]),
    );
    expect(res.status).toBe(200);
    const r = rows(res as never);
    expect(r['nope.key']!.errors[0]).toMatch(/unknown rule_key/);
    expect(r['durability.S3.opt1.max_wcm']!.errors[0]).toMatch(/units "MPa" do not match/);
    expect(r['durability.S3.opt2.max_wcm']!.errors[0]).toMatch(/requirement_class/);
    expect(r['durability.W2.max_wcm']!.errors[0]).toMatch(/placeholder/);
    expect(r['durability.F3.max_wcm']!.errors[0]).toMatch(/needs a number/);
    expect(
      res.body.rows
        .filter((x: { ruleKey: string; status: string }) => x.ruleKey === 'durability.F3.min_fc')
        .map((x: { status: string }) => x.status),
    ).toEqual(['ok', 'error']);
    expect(r['air.F1.target_pct']!.errors[0]).toMatch(/value_json/);
    expect(res.body.summary.errors).toBe(7);
    expect(await env.db.select().from(schema.rules)).toHaveLength(before.length); // preview wrote no rules
  });

  it('rejects malformed files: missing or unknown columns, no data, wrong role', async () => {
    expect((await preview('rule_key,value\nx,1')).body.fileErrors.join()).toMatch(
      /missing column "units"/,
    );
    expect(
      (
        await preview(
          csv(
            [['durability.S2.max_wcm', '0.45', 'ratio', 'c', 'CODE_HARD', 'x']],
            ['rule_key', 'value', 'units', 'clause_ref', 'requirement_class', 'surprise'],
          ),
        )
      ).body.fileErrors.join(),
    ).toMatch(/unknown column "surprise"/);
    expect(
      (await preview('rule_key,value,units,clause_ref,requirement_class')).body.fileErrors.join(),
    ).toMatch(/no data rows/);
    expect((await preview(csv(GOOD), qce)).status).toBe(403);
    expect((await viewer.post('/api/rules/import/preview').send({ csv: 'x' })).status).toBe(403);
    expect((await qcm.post('/api/rules/import/preview').send({})).status).toBe(400);
  });

  it('commits exactly what was previewed: new unverified versions, Arabic notes kept, audited', async () => {
    const p = await preview('﻿' + csv(GOOD)); // Excel writes a BOM
    expect(p.body.summary).toMatchObject({ total: 5, ok: 5, errors: 0 });
    const before = (await env.auditRows()).length;
    const res = await qcm.post('/api/rules/import/commit').send({ batchId: p.body.batchId });
    expect(res.status).toBe(200);
    expect(res.body.applied).toBe(5);
    const w = await rule('JS', 'durability.S2.max_wcm');
    expect(w).toMatchObject({
      value: 0.45,
      version: 2,
      verified: false,
      origin: 'csv',
      status: 'unverified',
    });
    const detail = (await qcm.get(`/api/rules/${w.id}`)).body.rule;
    expect(detail.noteAr).toBe('أقصى نسبة ماء إلى مواد إسمنتية');
    expect(detail.clauseRef).toBe('JSC-2022 §7.3.1');
    expect((await rule('JS', 'nmas.max_fraction.slab_depth')).value).toBe('1/3');
    expect((await rule('JS', 'durability.S2.cacl2_prohibited')).value).toBe(true);
    expect((await rule('JS', 'durability.S2.sulfate_cement')).value).toEqual(['high']);
    const audit = (await env.auditRows()).slice(before);
    expect(audit.filter((a) => a.action === 'rule.update')).toHaveLength(5);
    expect(audit.filter((a) => a.action === 'rule_import.commit')).toHaveLength(1);
  });

  it('a batch cannot be committed twice; unchanged rows are not re-versioned', async () => {
    const p = await preview(csv(GOOD));
    expect(p.body.summary).toMatchObject({ ok: 0, unchanged: 5, errors: 0 });
    const first = await qcm.post('/api/rules/import/commit').send({ batchId: p.body.batchId });
    expect(first.body.applied).toBe(0);
    expect(
      (await qcm.post('/api/rules/import/commit').send({ batchId: p.body.batchId })).status,
    ).toBe(409);
    expect((await rule('JS', 'durability.S2.max_wcm')).version).toBe(2);
  });

  it('refuses to commit a preview with errors, and one that went stale', async () => {
    const bad = await preview(csv([['nope', '1', 'ratio', 'c', 'CODE_HARD', '', '', '']]));
    const res = await qcm.post('/api/rules/import/commit').send({ batchId: bad.body.batchId });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('preview_has_errors');

    const stale = await preview(
      csv([['durability.F3.max_wcm', '0.40', 'ratio', 'JSC-2022 §7.3.5', 'CODE_HARD', '', '', '']]),
    );
    const target = await rule('JS', 'durability.F3.max_wcm');
    await qcm
      .patch(`/api/rules/${target.id}/value`)
      .send({ value: 0.41, reason: 'edited between preview and commit' });
    const late = await qcm.post('/api/rules/import/commit').send({ batchId: stale.body.batchId });
    expect(late.status).toBe(409);
    expect(late.body.error.message).toMatch(/changed since the preview/);
    expect((await rule('JS', 'durability.F3.max_wcm')).value).toBe(0.41); // nothing half-applied
  });

  it('supports inheriting an ACI value by reference and table values via value_json', async () => {
    const table = JSON.stringify({
      cols: { name: 'nmas_mm', values: [9.5, 12.5] },
      data: [[6, 5.5]],
      interpolation: 'linear',
    });
    const p = await preview(
      csv([
        [
          'durability.S1.min_fc',
          'inherits:ACI:durability.S1.min_fc',
          'MPa',
          'JSC-2022 §7.2 (same as ACI)',
          'CODE_HARD',
          '',
          '',
          '',
        ],
        ['air.F1.target_pct', '', '%', 'JSC-2022 §8.1', 'CODE_HARD', '', '', table],
        [
          'durability.S1.max_wcm',
          'inherits:ACI:no.such.rule',
          'ratio',
          'JSC-2022 §7.2',
          'CODE_HARD',
          '',
          '',
          '',
        ],
      ]),
    );
    const r = rows(p as never);
    expect(r['durability.S1.min_fc']!.status).toBe('ok');
    expect(r['air.F1.target_pct']!.status).toBe('ok');
    expect(r['durability.S1.max_wcm']!.errors[0]).toMatch(/does not exist/);
  });
});

describe('resolving through the API', () => {
  const body = (extra: object) => ({ mode: 'ACI', context: { exposure: ['S2'] }, ...extra });

  it('needs rules.read and a valid body', async () => {
    expect((await viewer.post('/api/rules/resolve').send(body({}))).status).toBe(403);
    expect((await qce.post('/api/rules/resolve').send({ mode: 'EU', context: {} })).status).toBe(
      400,
    );
  });

  it('resolves from the database (not from seed files) with provenance and approval blockers', async () => {
    const res = await qce.post('/api/rules/resolve').send(body({}));
    expect(res.status).toBe(200);
    const w = res.body.requirements.find(
      (r: { requirement: string }) => r.requirement === 'max_wcm',
    );
    expect(w).toMatchObject({ value: 0.45, status: 'resolved', verified: false });
    expect(w.governing).toMatchObject({
      source: 'ACI',
      ruleKey: 'durability.S2.max_wcm',
      clause_ref: 'ACI 318-19 Table 19.3.2.1',
    });
    expect(res.body.blockers.approvable).toBe(false);
    expect(res.body.blockers.unverified.length).toBeGreaterThan(0);
  });

  it('Both mode uses the Jordanian values imported above and reports what is still missing', async () => {
    const res = await qce
      .post('/api/rules/resolve')
      .send(body({ mode: 'BOTH', context: { exposure: ['S2', 'F2'] } }));
    const byReq = Object.fromEntries(
      res.body.requirements.map((r: { requirement: string }) => [r.requirement, r]),
    );
    expect(byReq['max_wcm']).toMatchObject({ value: 0.45 });
    expect(byReq['max_wcm'].contributions.map((c: { source: string }) => c.source).sort()).toEqual([
      'ACI',
      'ACI',
      'JS',
      'JS',
    ]);
    expect(byReq['max_wcm'].status).toBe('provisional'); // JS has no F2 value yet
    expect(byReq['max_wcm'].issues.map((i: { code: string }) => i.code)).toContain('value_missing');
  });

  it('a looser project override is rejected with the governing clause, a tighter one governs', async () => {
    const loose = await qce
      .post('/api/rules/resolve')
      .send(body({ project_overrides: [{ requirement: 'max_wcm', value: 0.5 }] }));
    expect(loose.body.rejectedOverrides[0]).toMatchObject({
      requirement: 'max_wcm',
      code: 'override_loosens',
      allowed: 0.45,
    });
    expect(loose.body.rejectedOverrides[0].governing.clause_ref).toBe('ACI 318-19 Table 19.3.2.1');
    const tight = await qce.post('/api/rules/resolve').send(
      body({
        project_overrides: [{ requirement: 'max_wcm', value: 0.4, clause_ref: 'Spec 03300 §2.4' }],
      }),
    );
    expect(
      tight.body.requirements.find((r: { requirement: string }) => r.requirement === 'max_wcm')
        .governing.source,
    ).toBe('PROJECT');
  });

  it('is read-only: it writes no audit rows and changes no rules', async () => {
    const before = (await env.auditRows()).length;
    await qce.post('/api/rules/resolve').send(body({}));
    expect((await env.auditRows()).length).toBe(before);
  });

  it('a verified rule resolves as verified; the gate lists exactly what is left', async () => {
    const s2 = await rule('ACI', 'durability.S2.max_wcm');
    // (qcm last edited this rule in the sync test, so by four-eyes the other QC manager signs)
    const signed = await qcm2
      .post(`/api/rules/${s2.id}/verify`)
      .send({ note: 'Checked against licensed ACI 318-19' });
    expect(signed.status).toBe(200);
    const res = await qce.post('/api/rules/resolve').send(body({ context: { exposure: ['S2'] } }));
    const w = res.body.requirements.find(
      (r: { requirement: string }) => r.requirement === 'max_wcm',
    );
    expect(w.verified).toBe(true);
    expect(res.body.blockers.unverified.map((u: { ruleKey: string }) => u.ruleKey)).not.toContain(
      'durability.S2.max_wcm',
    );
  });
});

describe('tenant isolation', () => {
  it("another tenant cannot see or change this tenant's rules", async () => {
    const other = await env.seedTenant('rules-other');
    const foreign = await env.login(
      (await env.seedUser('qc_manager', { tenantId: other.id })).email,
    );
    expect((await foreign.get('/api/rules')).body.rules).toEqual([]);
    const mine = await rule('ACI', 'durability.S1.min_fc');
    expect((await foreign.get(`/api/rules/${mine.id}`)).status).toBe(404);
    expect(
      (await foreign.post(`/api/rules/${mine.id}/verify`).send({ note: 'not my rule at all' }))
        .status,
    ).toBe(404);
    expect(
      (await foreign.patch(`/api/rules/${mine.id}/value`).send({ value: 1, reason: 'not my rule' }))
        .status,
    ).toBe(404);
    const sync = await env.db.transaction((tx) =>
      syncRules(tx, { record: async () => {} }, other.id, seeds),
    );
    expect(sync.inserted).toBe(seeds.rules.length); // its own copy
    const count = await env.db
      .select()
      .from(schema.rules)
      .where(and(eq(schema.rules.tenantId, env.tenantId), eq(schema.rules.isCurrent, true)));
    expect(count).toHaveLength(seeds.rules.length);
  });
});
