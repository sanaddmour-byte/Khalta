import { schema } from '@khalta/db';
import { createHash } from 'node:crypto';
import { and, eq, isNull, or, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { ApiError, notFound } from '../errors';
import type { ApiRoutes } from '../route';

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

/** Content type from the file signature (never from the client): PDF, PNG or JPEG only. */
export function sniff(buf: Buffer): string | null {
  if (buf.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
    return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  return null;
}

const cleanName = (n: string) =>
  [...n]
    .map((c) => (c === '/' || c === '\\' || c.charCodeAt(0) < 32 ? '_' : c))
    .join('')
    .trim()
    .slice(0, 200) || 'attachment';

const idParam = z.object({ id: z.uuid() });
const uploadQuery = z.object({ filename: z.string().max(400).optional() });

export function attachmentRoutes(api: ApiRoutes) {
  api.upload(
    '/api/attachments',
    {
      summary: 'Upload an evidence file (PDF, PNG or JPEG, ≤ 10 MB) as the raw request body',
      capability: 'lab.enter',
      query: uploadQuery,
      limitBytes: MAX_ATTACHMENT_BYTES,
    },
    async ({ auth, body, query, tx, audit }) => {
      if (body.length === 0) throw new ApiError(400, 'invalid_request', 'The upload is empty');
      const contentType = sniff(body);
      if (!contentType) throw new ApiError(415, 'unsupported_type', 'Only PDF, PNG and JPEG files are accepted');
      const sha256 = createHash('sha256').update(body).digest('hex');
      const [row] = await tx
        .insert(schema.attachments)
        .values({
          tenantId: auth.tenantId,
          filename: cleanName(query.filename ?? 'attachment'),
          contentType,
          sizeBytes: body.length,
          sha256,
          data: body,
          createdBy: auth.user.id,
        })
        .returning({
          id: schema.attachments.id,
          filename: schema.attachments.filename,
          contentType: schema.attachments.contentType,
          sizeBytes: schema.attachments.sizeBytes,
          sha256: schema.attachments.sha256,
        });
      if (!row) throw new Error('insert failed');
      await audit.record({ action: 'attachment.upload', entityType: 'attachment', entityId: row.id, after: row });
      return row;
    },
  );

  api.file(
    '/api/attachments/:id',
    { summary: 'Download an evidence file', capability: 'materials.read', params: idParam },
    async ({ auth, params, db }) => {
      const [a] = await db
        .select()
        .from(schema.attachments)
        .where(and(eq(schema.attachments.id, params.id), eq(schema.attachments.tenantId, auth.tenantId)));
      if (!a) throw notFound('Attachment not found');
      if (!auth.scope.all) {
        // plant-scoped users may open files only for materials they can see (tenant-level or own plant)
        const rows = await db
          .select({ id: schema.materialTests.id })
          .from(schema.materialTests)
          .innerJoin(schema.materials, eq(schema.materials.id, schema.materialTests.materialId))
          .where(
            and(
              eq(schema.materialTests.attachmentId, a.id),
              or(
                isNull(schema.materials.plantId),
                auth.scope.plantIds.length ? inArray(schema.materials.plantId, [...auth.scope.plantIds]) : undefined,
              ),
            ),
          );
        if (rows.length === 0) throw notFound('Attachment not found');
      }
      return { filename: a.filename, contentType: a.contentType, data: a.data };
    },
  );
}
