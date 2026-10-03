// SYNTHETIC strength fixtures for the e2e database only: three w/cm levels of one live design's group, with 12 sets
// (two cylinders each) per level around ln f = A − B·w/cm and a deterministic wobble. Not a plant's data.
import { expect } from '@playwright/test';
import { as, liveDesign, seedLifecycleWorld, withDb } from './lifecycle-world';
import { emailFor } from './support';

const A = 4.6;
const B = 2.2;
let ready: Promise<{ live: string; versions: string[] }> | null = null;

export function seedStrengthWorld(code = 'STR-E2E-1') {
  return (ready ??= (async () => {
    const plantId = await seedLifecycleWorld();
    const live = await liveDesign(code);
    const mgr = await as(emailFor('qc_manager'));
    const lines = await withDb(async (c) => {
      const { rows } = await c.query(
        `SELECT l.material_id AS id, l.quantity_kg_m3 AS q, m.category FROM mix_design_lines l
         JOIN materials m ON m.id = l.material_id WHERE l.design_id = $1`,
        [live],
      );
      return rows as { id: string; q: string; category: string }[];
    });
    const versions: string[] = [];
    for (const k of [0.85, 1.0, 1.15]) {
      const made = await mgr.post(`/api/designs/${live}/versions`, {
        data: {
          note: 'SYNTHETIC water level',
          lines: lines.map((l) => ({
            materialId: l.id,
            kgPerM3: l.category === 'water' ? (Number(l.q) * k).toFixed(3) : l.q,
          })),
        },
      });
      expect(made.ok(), await made.text()).toBe(true);
      const id = ((await made.json()) as { id: string }).id;
      const ev = await mgr.post(`/api/designs/${id}/evaluate`, { data: { mode: 'ACI' } });
      expect(ev.ok(), await ev.text()).toBe(true);
      versions.push(id);
    }
    await withDb(async (c) => {
      const { rows: pl } = await c.query(`SELECT tenant_id FROM plants WHERE id = $1`, [plantId]);
      for (const id of versions) {
        const { rows } = await c.query(
          `SELECT (e.report->'figures'->>'ratio.wcm')::float AS w FROM mix_designs d
           JOIN design_evaluations e ON e.id = d.last_evaluation_id WHERE d.id = $1`,
          [id],
        );
        const w = rows[0].w as number;
        for (let i = 0; i < 12; i++) {
          const f = Math.exp(A - B * w) + (((i * 7) % 5) - 2) * 0.4;
          for (const k of [0, 1])
            await c.query(
              `INSERT INTO strength_results (tenant_id, plant_id, design_id, cast_date, age_days, specimen_type, set_id, result_mpa)
               VALUES ($1, $2, $3, CURRENT_DATE - $4::int, 28, 'cylinder', $5, $6)`,
              [
                pl[0].tenant_id,
                plantId,
                id,
                5 + i,
                `E${i}`,
                (f + (k === 0 ? 0.2 : -0.2)).toFixed(2),
              ],
            );
        }
      }
    });
    return { live, versions };
  })());
}
