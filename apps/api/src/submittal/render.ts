// The bilingual PDF submittal (F-025): HTML built on the server and printed by Chromium (`page.pdf()`), so Arabic
// shaping and bidi are the browser's. Everything here is derived from stored records; no cost field exists in the
// data this module reads, so cost cannot reach the page. The watermark follows the design's state and has no off switch.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { schema, type Executor } from '@khalta/db';
import type { EvaluationReport } from '@khalta/engine';
import { asc, desc, eq, inArray, and } from 'drizzle-orm';
import { chromium, type Browser } from 'playwright-core';
import QRCode from 'qrcode';
import type { DesignRow } from '../evaluation/service';
import type { Settings } from '../settings';
import { MEANING, S, STATE, type Key, type Lang } from './strings';

const esc = (v: unknown) =>
  String(v ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );

interface Line {
  materialId: string;
  nameEn: string;
  nameAr: string | null;
  category: string;
  kg: number;
  testSource: string | null;
  testedAt: string | null;
  testVersion: number | null;
  declared: boolean;
  sieve: { sieve_mm: number; passing_pct: number }[] | null;
}
export interface SubmittalData {
  design: { id: string; code: string; version: number; status: string; name: string };
  plant: { nameEn: string; nameAr: string };
  letterhead: Settings['letterhead'];
  requirements: Record<string, unknown>;
  lines: Line[];
  batch: { at: string; kind: string; kg: Record<string, number> } | null;
  report: EvaluationReport | null;
  trial: {
    testAgeDays: number | null;
    batches: {
      id: string;
      batchedOn: string;
      slumpMm: string | null;
      airPct: string | null;
      temperatureC: string | null;
      freshDensityKgM3: string | null;
      yieldM3: string | null;
    }[];
    results: {
      trialBatchId: string | null;
      ageDays: number;
      setId: string;
      resultMpa: string;
      specimenType: string;
    }[];
  };
  approvals: {
    toStatus: string;
    at: string;
    actor: string | null;
    esignature: { meaning: string; signerName: string; reason: string } | null;
    evidence: Record<string, unknown>;
  }[];
  externalApprovalRef: string | null;
}

export async function gatherSubmittal(
  db: Executor,
  tenantId: string,
  d: DesignRow,
  settings: Settings,
): Promise<SubmittalData> {
  const [plant] = await db.select().from(schema.plants).where(eq(schema.plants.id, d.plantId));
  const lines = await db
    .select({
      materialId: schema.mixDesignLines.materialId,
      kg: schema.mixDesignLines.quantityKgM3,
      nameEn: schema.materials.marketNameEn,
      nameAr: schema.materials.marketNameAr,
      category: schema.materials.category,
    })
    .from(schema.mixDesignLines)
    .innerJoin(schema.materials, eq(schema.materials.id, schema.mixDesignLines.materialId))
    .where(eq(schema.mixDesignLines.designId, d.id))
    .orderBy(asc(schema.mixDesignLines.sourceLine));
  const ids = lines.map((l) => l.materialId);
  const tests = ids.length
    ? await db
        .select()
        .from(schema.materialTests)
        .where(
          and(
            eq(schema.materialTests.tenantId, tenantId),
            inArray(schema.materialTests.materialId, ids),
            eq(schema.materialTests.isCurrent, true),
          ),
        )
    : [];
  const [ev] = d.lastEvaluationId
    ? await db
        .select({ report: schema.designEvaluations.report })
        .from(schema.designEvaluations)
        .where(eq(schema.designEvaluations.id, d.lastEvaluationId))
    : [];
  const report = (ev?.report as EvaluationReport | undefined) ?? null;
  const declared = new Set(
    report?.dataQuality
      .filter((q) => q.code === 'declared_values' && q.materialId)
      .map((q) => q.materialId!),
  );
  const [bi] = await db
    .select()
    .from(schema.batchInstances)
    .where(eq(schema.batchInstances.designId, d.id))
    .orderBy(desc(schema.batchInstances.createdAt))
    .limit(1);
  const biLines =
    (bi?.result as { lines?: { materialId: string; kgBatch: number }[] } | undefined)?.lines ?? [];
  const batches = await db
    .select()
    .from(schema.trialBatches)
    .where(eq(schema.trialBatches.designId, d.id))
    .orderBy(asc(schema.trialBatches.batchedOn));
  const results = await db
    .select()
    .from(schema.strengthResults)
    .where(eq(schema.strengthResults.designId, d.id))
    .orderBy(asc(schema.strengthResults.castDate));
  const trs = await db
    .select({
      toStatus: schema.designTransitions.toStatus,
      at: schema.designTransitions.at,
      actor: schema.users.name,
      esignature: schema.designTransitions.esignature,
      evidence: schema.designTransitions.evidence,
    })
    .from(schema.designTransitions)
    .leftJoin(schema.users, eq(schema.users.id, schema.designTransitions.actorId))
    .where(eq(schema.designTransitions.designId, d.id))
    .orderBy(asc(schema.designTransitions.at));
  return {
    design: { id: d.id, code: d.code, version: d.version, status: d.status, name: d.name },
    plant: { nameEn: plant?.nameEn ?? '', nameAr: plant?.nameAr ?? '' },
    letterhead: settings.letterhead,
    requirements: d.requirements as Record<string, unknown>,
    lines: lines.map((l) => {
      const t = tests.find((x) => x.materialId === l.materialId);
      const sa = (
        t?.properties as
          { sieve_analysis?: { sieve_mm: number; passing_pct: number }[] } | undefined
      )?.sieve_analysis;
      return {
        materialId: l.materialId,
        nameEn: l.nameEn,
        nameAr: l.nameAr,
        category: l.category,
        kg: Number(l.kg),
        testSource: t?.source ?? null,
        testedAt: t?.testedAt ?? null,
        testVersion: t?.version ?? null,
        declared: declared.has(l.materialId),
        sieve: Array.isArray(sa) ? sa : null,
      };
    }),
    batch: bi
      ? {
          at: bi.createdAt.toISOString(),
          kind: bi.kind,
          kg: Object.fromEntries(biLines.map((x) => [x.materialId, x.kgBatch])),
        }
      : null,
    report,
    trial: {
      testAgeDays: (d.requirements as { testAgeDays?: number }).testAgeDays ?? null,
      batches: batches.map((b) => ({
        id: b.id,
        batchedOn: b.batchedOn,
        slumpMm: b.slumpMm,
        airPct: b.airPct,
        temperatureC: b.temperatureC,
        freshDensityKgM3: b.freshDensityKgM3,
        yieldM3: b.yieldM3,
      })),
      results: results.map((r) => ({
        trialBatchId: r.trialBatchId,
        ageDays: r.ageDays,
        setId: r.setId,
        resultMpa: r.resultMpa,
        specimenType: r.specimenType,
      })),
    },
    approvals: trs
      .filter((t) => ['approved', 'in_production', 'trial_passed'].includes(t.toStatus))
      .map((t) => ({
        toStatus: t.toStatus,
        at: t.at.toISOString(),
        actor: t.actor,
        esignature: t.esignature as never,
        evidence: t.evidence as Record<string, unknown>,
      })),
    externalApprovalRef: d.externalApprovalRef,
  };
}

/** Combined grading from the stored sieve analyses and the proportions (sieves present in every aggregate). */
export function combinedGrading(lines: Line[]): { sieve_mm: number; passing_pct: number }[] {
  const aggs = lines.filter((l) => l.category.endsWith('_agg') && l.sieve && l.sieve.length > 0);
  const total = aggs.reduce((s, l) => s + l.kg, 0);
  if (aggs.length === 0 || total === 0) return [];
  const common = aggs
    .map((l) => new Set(l.sieve!.map((p) => p.sieve_mm)))
    .reduce((a, b) => new Set([...a].filter((x) => b.has(x))));
  return [...common]
    .sort((a, b) => b - a)
    .map((s) => ({
      sieve_mm: s,
      passing_pct: aggs.reduce(
        (acc, l) => acc + (l.kg / total) * l.sieve!.find((p) => p.sieve_mm === s)!.passing_pct,
        0,
      ),
    }));
}

function gradationSvg(pts: { sieve_mm: number; passing_pct: number }[]): string {
  if (pts.length < 2) return '';
  const W = 520,
    H = 220,
    L = 44,
    R = 12,
    T = 12,
    B = 34;
  const lo = Math.log10(Math.min(...pts.map((p) => p.sieve_mm)));
  const hi = Math.log10(Math.max(...pts.map((p) => p.sieve_mm)));
  const x = (s: number) => L + ((hi - Math.log10(s)) / (hi - lo || 1)) * (W - L - R); // coarse on the left
  const y = (p: number) => T + (1 - p / 100) * (H - T - B);
  const grid = [0, 25, 50, 75, 100]
    .map(
      (p) =>
        `<line x1="${L}" x2="${W - R}" y1="${y(p)}" y2="${y(p)}" stroke="#d8d8d8"/><text x="${L - 6}" y="${y(p) + 3}" text-anchor="end" font-size="9">${p}</text>`,
    )
    .join('');
  const ticks = pts
    .map(
      (p) =>
        `<text x="${x(p.sieve_mm)}" y="${H - B + 14}" text-anchor="middle" font-size="9">${p.sieve_mm}</text>`,
    )
    .join('');
  const path = pts
    .map((p, i) => `${i ? 'L' : 'M'}${x(p.sieve_mm).toFixed(1)},${y(p.passing_pct).toFixed(1)}`)
    .join(' ');
  const dots = pts
    .map(
      (p) =>
        `<circle cx="${x(p.sieve_mm).toFixed(1)}" cy="${y(p.passing_pct).toFixed(1)}" r="2.5" fill="#14663d"/>`,
    )
    .join('');
  return `<svg dir="ltr" viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="grading">${grid}${ticks}<path d="${path}" fill="none" stroke="#14663d" stroke-width="1.8"/>${dots}</svg>`;
}

const require_ = createRequire(import.meta.url);
let fontCss: string | null = null;
function fonts(): string {
  if (fontCss) return fontCss;
  const face = (family: string, pkg: string, file: string, weight: number) => {
    const dir = path.dirname(require_.resolve(`${pkg}/package.json`));
    const b64 = readFileSync(path.join(dir, 'files', file)).toString('base64');
    return `@font-face{font-family:'${family}';font-weight:${weight};src:url(data:font/woff2;base64,${b64}) format('woff2');}`;
  };
  const sans = '@fontsource/ibm-plex-sans';
  const ar = '@fontsource/ibm-plex-sans-arabic';
  fontCss = [
    face('KhaltaSans', sans, 'ibm-plex-sans-latin-400-normal.woff2', 400),
    face('KhaltaSans', sans, 'ibm-plex-sans-latin-600-normal.woff2', 600),
    face('KhaltaArabic', ar, 'ibm-plex-sans-arabic-arabic-400-normal.woff2', 400),
    face('KhaltaArabic', ar, 'ibm-plex-sans-arabic-arabic-600-normal.woff2', 600),
    face('KhaltaArabic', ar, 'ibm-plex-sans-arabic-latin-400-normal.woff2', 400),
  ].join('\n');
  return fontCss;
}

const fmt = (v: unknown, dp = 3) =>
  typeof v === 'number'
    ? Number.isInteger(v)
      ? String(v)
      : v.toFixed(dp).replace(/\.?0+$/, '')
    : esc(v);

export async function submittalHtml(
  data: SubmittalData,
  lang: Lang,
  appBase: string,
  printedAt: Date,
): Promise<string> {
  const both = lang === 'both';
  const L = (k: Key) =>
    both
      ? `<span class="en">${S[k][0]}</span><span class="ar" dir="rtl">${S[k][1]}</span>`
      : `<span>${S[k][lang === 'ar' ? 1 : 0]}</span>`;
  const T = (pair: readonly [string, string]) =>
    both
      ? `<span class="en">${pair[0]}</span><span class="ar" dir="rtl">${pair[1]}</span>`
      : `<span>${pair[lang === 'ar' ? 1 : 0]}</span>`;
  const name = (l: { nameEn: string; nameAr: string | null }) =>
    lang === 'ar'
      ? esc(l.nameAr ?? l.nameEn)
      : both
        ? `${esc(l.nameEn)}${l.nameAr ? ` <span dir="rtl" class="ar">${esc(l.nameAr)}</span>` : ''}`
        : esc(l.nameEn);
  const d = data.design;
  const approved = d.status === 'approved' || d.status === 'in_production';
  const watermark = approved
    ? null
    : d.status === 'superseded'
      ? S.watermarkSuperseded
      : d.status === 'retired'
        ? S.watermarkRetired
        : S.watermarkTrial;
  const qr = await QRCode.toDataURL(`${appBase}/library?design=${d.id}`, { margin: 1, width: 160 });
  const r = data.requirements as {
    fcMpa?: number;
    basis?: string;
    testAgeDays?: number;
    exposure?: string[];
    slumpMm?: number;
    nmasMm?: number;
    pumpable?: boolean;
  };
  const lh = data.letterhead;
  const head = lh
    ? `<div class="lh">${lh.logoDataUrl ? `<img src="${lh.logoDataUrl}" alt="" class="logo"/>` : ''}<div><strong>${lang === 'ar' ? esc(lh.nameAr) : esc(lh.nameEn)}${both ? ` / <span dir="rtl">${esc(lh.nameAr)}</span>` : ''}</strong><br/>${esc(lang === 'ar' ? lh.addressAr : lh.addressEn)}</div></div>`
    : `<div class="lh"><div><strong>${name({ nameEn: data.plant.nameEn, nameAr: data.plant.nameAr })}</strong></div></div>`;
  const rep = data.report;
  const rows = (cells: string[][]) =>
    cells.map((r2) => `<tr>${r2.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('');
  const th = (ks: Key[]) => `<tr>${ks.map((k) => `<th>${L(k)}</th>`).join('')}</tr>`;
  const grading = combinedGrading(data.lines);
  const fcr = rep?.strength.fcrMpa ?? null;
  const results = data.trial.results.filter((x) => x.ageDays === data.trial.testAgeDays);

  const body = `
${watermark ? `<div class="banner">${both ? `${watermark[0]} / <span dir="rtl">${watermark[1]}</span>` : watermark[lang === 'ar' ? 1 : 0]}</div>` : ''}
<header>${head}<div class="meta"><img class="qr" src="${qr}" alt="QR"/><div class="qrcap">${L('qr')}</div></div></header>
<h1>${L('title')}</h1>
<table class="kv">
<tr><th>${L('code')}</th><td dir="ltr">${esc(d.code)}</td><th>${L('version')}</th><td dir="ltr">v${d.version}</td></tr>
<tr><th>${L('state')}</th><td>${T(STATE[d.status] ?? [d.status, d.status])}</td><th>${L('plant')}</th><td>${name(data.plant)}</td></tr>
<tr><th>${L('printed')}</th><td dir="ltr" colspan="3">${esc(printedAt.toISOString().slice(0, 10))}</td></tr>
</table>

<h2>${L('req')}</h2>
<table class="kv">
<tr><th>${L('strength')}</th><td dir="ltr">${fmt(r.fcMpa)} MPa</td><th>${L('basis')}</th><td>${esc(r.basis ?? '–')}</td></tr>
<tr><th>${L('age')}</th><td dir="ltr">${fmt(r.testAgeDays)}</td><th>${L('exposure')}</th><td dir="ltr">${esc((r.exposure ?? []).join(' ') || '–')}</td></tr>
<tr><th>${L('slump')}</th><td dir="ltr">${fmt(r.slumpMm)}</td><th>${L('nmas')}</th><td dir="ltr">${fmt(r.nmasMm)}</td></tr>
<tr><th>${L('pumpable')}</th><td>${r.pumpable == null ? '–' : L(r.pumpable ? 'yes' : 'no')}</td><td></td><td></td></tr>
</table>

<h2>${L('materials')}</h2>
<table>${th(['material', 'category', 'source', 'tested'])}${rows(
    data.lines.map((l) => [
      `${name(l)}${l.declared ? ` <em class="flag">${L('declared')}</em>` : ''}`,
      esc(l.category),
      esc(l.testSource ?? '–') + (l.testVersion ? ` (v${l.testVersion})` : ''),
      `<span dir="ltr">${esc(l.testedAt ?? '–')}</span>`,
    ]),
  )}</table>

<h2>${L('proportions')}</h2>
<table>${th(data.batch ? ['material', 'ssd', 'batch'] : ['material', 'ssd'])}${rows(
    data.lines.map((l) => [
      name(l),
      `<span dir="ltr">${fmt(l.kg)}</span>`,
      ...(data.batch ? [`<span dir="ltr">${fmt(data.batch.kg[l.materialId] ?? null)}</span>`] : []),
    ]),
  )}</table>
${data.batch ? `<p class="note">${L('batchNote')}: <span dir="ltr">${esc(data.batch.at.slice(0, 16).replace('T', ' '))}</span></p>` : ''}

<h2>${L('compliance')}</h2>
${
  rep
    ? `<table class="small">${th(['check', 'value', 'limit', 'status', 'governing', 'evidence'])}${rows(
        rep.checks.map((c) => [
          `<span dir="ltr">${esc(c.id)}</span>`,
          `<span dir="ltr">${typeof c.value === 'number' ? fmt(c.value, 4) : esc(c.value ?? '–')} ${esc(c.units)}</span>`,
          `<span dir="ltr">${esc(c.op ?? '')} ${esc(Array.isArray(c.limit) ? c.limit.join(',') : (c.limit ?? '–'))}</span>`,
          T(S[c.status as 'pass' | 'fail' | 'not_evaluated']),
          `<span dir="ltr">${esc(c.governing ? `${c.governing.source} ${c.governing.clause}` : '–')}</span>`,
          `<span dir="ltr">${esc(c.evidence.join(', '))}</span>`,
        ]),
      )}</table>`
    : '<p>–</p>'
}

<h2>${L('strengthEv')}</h2>
<table class="kv"><tr><th>${L('fcr')}</th><td dir="ltr">${fcr === null ? '–' : fmt(fcr, 2)}</td></tr></table>
${rep && rep.strength.branches.length ? `<table class="small"><tr><th>${L('branch')}</th><th></th></tr>${rows(rep.strength.branches.map((b) => [`<span dir="ltr">${esc(b.ruleset)}</span>`, `<span dir="ltr">${b.value === null ? '–' : fmt(b.value, 2)} MPa · ${esc(b.branch ?? '–')} · ${esc(b.clause ?? '')}</span>`]))}</table>` : ''}
<h3>${L('trial')}</h3>
${
  data.trial.batches.length === 0
    ? `<p>${L('noTrial')}</p>`
    : `<table class="small">${rows(
        data.trial.batches.map((b) => [
          `<span dir="ltr">${esc(b.batchedOn)}</span>`,
          `<span dir="ltr">${esc(`slump ${b.slumpMm ?? '–'} · air ${b.airPct ?? '–'} · T ${b.temperatureC ?? '–'} · ρ ${b.freshDensityKgM3 ?? '–'} · yield ${b.yieldM3 ?? '–'}`)}</span>`,
          `${L('specimens')}: <span dir="ltr">${esc(
            results
              .filter((x) => x.trialBatchId === b.id)
              .map((x) => x.resultMpa)
              .join(', ') || '–',
          )}</span>`,
        ]),
      )}</table>`
}

${grading.length >= 2 ? `<h2>${L('gradation')}</h2>${gradationSvg(grading)}<p class="note">${L('gradationNote')}</p>` : ''}

${
  rep && rep.characteristics.rows.length
    ? `<h2>${L('chars')}</h2><table class="small">${th(['check', 'requested', 'achieved', 'origin'])}${rows(
        rep.characteristics.rows.map((c) => [
          `<span dir="ltr">${esc(c.key)}</span>`,
          `<span dir="ltr">${esc(c.requested)}</span>`,
          `<span dir="ltr">${esc(c.achieved ?? '–')} ${esc(c.unit)}</span>`,
          `<span dir="ltr">${esc(c.origin)}</span>`,
        ]),
      )}</table>`
    : ''
}

<h2>${L('approval')}</h2>
${
  data.externalApprovalRef
    ? `<p>${L('legacy')}: <strong dir="ltr">${esc(data.externalApprovalRef)}</strong></p>`
    : ''
}
${
  data.approvals.length === 0 && !data.externalApprovalRef
    ? `<p>${L('notApprovedYet')}</p>`
    : `<table class="small">${th(['state', 'by', 'on', 'meaning', 'reason'])}${rows(
        data.approvals.map((a) => [
          T(STATE[a.toStatus] ?? [a.toStatus, a.toStatus]),
          esc(a.esignature?.signerName ?? a.actor ?? '–'),
          `<span dir="ltr">${esc(a.at.slice(0, 10))}</span>`,
          a.esignature
            ? T(MEANING[a.esignature.meaning] ?? [a.esignature.meaning, a.esignature.meaning])
            : '–',
          esc(a.esignature?.reason ?? (a.evidence['note'] as string | undefined) ?? '–'),
        ]),
      )}</table>`
}

<p class="disc">${L('disclaimer')}</p>`;

  const wm = watermark
    ? `<div class="wm">${both ? `${watermark[0]}<br/><span dir="rtl">${watermark[1]}</span>` : watermark[lang === 'ar' ? 1 : 0]}</div>`
    : '';
  return `<!doctype html><html lang="${lang === 'ar' ? 'ar' : 'en'}" dir="${lang === 'ar' ? 'rtl' : 'ltr'}"><head><meta charset="utf-8"/><title>${esc(d.code)}</title><style>
${fonts()}
@page{size:A4;margin:16mm 14mm}
*{box-sizing:border-box}
body{font-family:'KhaltaSans','KhaltaArabic',sans-serif;font-size:10pt;color:#1b1b1b;margin:0}
html[lang=ar] body{font-family:'KhaltaArabic','KhaltaSans',sans-serif}
.ar{font-family:'KhaltaArabic',sans-serif;margin-inline-start:8px;color:#333}
.en+.ar::before{content:'/ ';}
h1{font-size:18pt;margin:10px 0}h2{font-size:12.5pt;margin:16px 0 6px;border-bottom:1px solid #999;padding-bottom:2px;break-after:avoid}h3{font-size:10.5pt;margin:10px 0 4px}
header{display:flex;justify-content:space-between;align-items:flex-start;gap:12px}
.lh{display:flex;gap:10px;align-items:center}.logo{max-height:48px;max-width:120px}
.meta{text-align:center}.qr{width:84px;height:84px}.qrcap{font-size:7pt;max-width:96px}
table{width:100%;border-collapse:collapse;margin:4px 0}th,td{border:1px solid #bbb;padding:3px 6px;vertical-align:top;text-align:start}
th{background:#f1f1ee;font-weight:600}table.kv th{width:22%}table.small{font-size:8.5pt}
tr{break-inside:avoid}.note{font-size:8.5pt;color:#444}.flag{color:#8a4b00;font-style:normal;font-size:8pt}
.banner{border:1.5px solid #b42318;color:#b42318;font-weight:600;text-align:center;padding:4px;margin-bottom:8px}
.disc{margin-top:16px;font-size:8.5pt;border:1px solid #999;padding:6px}
.wm{position:fixed;top:42%;left:0;right:0;text-align:center;font-size:44pt;font-weight:600;color:rgba(190,30,30,.16);transform:rotate(-28deg);pointer-events:none;z-index:9;line-height:1.1}
</style></head><body>${wm}${body}</body></html>`;
}

let browser: Promise<Browser> | null = null;
async function getBrowser(): Promise<Browser> {
  browser ??= chromium.launch({
    executablePath: process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] || undefined,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  return browser;
}
export async function closePdfBrowser() {
  if (browser) await (await browser).close();
  browser = null;
}

export async function renderPdf(html: string): Promise<Buffer> {
  const b = await getBrowser();
  const page = await b.newPage();
  try {
    await page.setContent(html, { waitUntil: 'load' });
    await page.evaluate('document.fonts.ready');
    return Buffer.from(
      await page.pdf({
        format: 'A4',
        printBackground: true,
        preferCSSPageSize: true,
        displayHeaderFooter: false,
      }),
    );
  } finally {
    await page.close();
  }
}
