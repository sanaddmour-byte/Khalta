// Production volumes (F-026): the produced m³ per design per month. Append-only: a correction is a new row with a
// note, and the latest row per month wins. Realized savings multiply by these and nothing else.
import { schema } from '@khalta/db';
import { monthOf, todayAmman } from '@khalta/engine';
import { desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { ApiError } from '../errors';
import { loadDesign } from '../evaluation/run';
import { effectiveVolumes } from '../savings/service';
import type { ApiRoutes } from '../route';

const idQuery = z.object({ designId: z.uuid() });
const body = z.strictObject({
  designId: z.uuid(),
  /** `YYYY-MM` */
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
  volumeM3: z.number().min(0).max(1_000_000),
  note: z.string().trim().max(300).optional(),
});

export function volumeRoutes(api: ApiRoutes) {
  api.get(
    '/api/production-volumes',
    {
      summary: 'Recorded monthly volumes of a design (latest row per month is in force)',
      capability: 'library.read',
      query: idQuery,
    },
    async ({ auth, query, db }) => {
      const d = await loadDesign(db, auth, query.designId);
      const inForce = await effectiveVolumes(db, d.id);
      const history = await db
        .select({
          id: schema.productionVolumes.id,
          month: schema.productionVolumes.month,
          volumeM3: schema.productionVolumes.volumeM3,
          source: schema.productionVolumes.source,
          note: schema.productionVolumes.note,
          createdAt: schema.productionVolumes.createdAt,
          actor: schema.users.name,
        })
        .from(schema.productionVolumes)
        .leftJoin(schema.users, eq(schema.users.id, schema.productionVolumes.createdBy))
        .where(eq(schema.productionVolumes.designId, d.id))
        .orderBy(desc(schema.productionVolumes.month), desc(schema.productionVolumes.createdAt));
      return {
        inForce: [...inForce.values()].map((v) => ({ month: v.month, volumeM3: v.volumeM3 })),
        history,
      };
    },
  );

  api.mutate(
    'post',
    '/api/production-volumes',
    {
      summary:
        'Record the produced volume of an approved or in-production design for a month (a correction needs a note)',
      capability: 'lab.enter',
      body,
      status: 201,
    },
    async ({ auth, body: b, tx, audit }) => {
      const d = await loadDesign(tx, auth, b.designId, true);
      if (!['approved', 'in_production', 'superseded'].includes(d.status))
        throw new ApiError(
          409,
          'conflict',
          'Volumes are recorded for approved or in-production designs',
        );
      const month = `${b.month}-01`;
      if (month > monthOf(todayAmman()))
        throw new ApiError(400, 'invalid_request', 'The month is in the future');
      const existing = (await effectiveVolumes(tx, d.id)).get(month);
      if (existing && !(b.note && b.note.length >= 3))
        throw new ApiError(
          400,
          'note_required',
          'This month already has a volume; a correction needs a note',
        );
      const [row] = await tx
        .insert(schema.productionVolumes)
        .values({
          tenantId: auth.tenantId,
          designId: d.id,
          plantId: d.plantId,
          month,
          volumeM3: b.volumeM3.toFixed(2),
          source: 'manual',
          note: b.note ?? null,
          createdBy: auth.user.id,
        })
        .returning({ id: schema.productionVolumes.id });
      await audit.record({
        action: 'production_volume.record',
        entityType: 'production_volume',
        entityId: row!.id,
        before: existing ? { volumeM3: existing.volumeM3 } : null,
        after: { designId: d.id, month, volumeM3: b.volumeM3, note: b.note ?? null },
      });
      return { id: row!.id, correction: !!existing };
    },
  );
}
