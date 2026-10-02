// Characteristic profiles (M3.3): CRUD with immutable versions, approval by a QC manager (four-eyes), the
// loosening check on save and at approval, matching for a request, diff and usage.
import { schema } from '@khalta/db';
import {
  diffVersions,
  mergeLayers,
  mergePreferences,
  defaultsOf,
  PLACEMENTS,
  PROFILE_SCOPES,
  SEASONS,
  idOf,
  matches,
  profileLayers,
  selectProfiles,
  specificity,
  originOf,
  checkCharacteristics,
  type AppliesTo,
  type EvaluationSnapshot,
  type ProfileVersionView,
} from '@khalta/engine';
import { limitContextFor } from '@khalta/engine/evaluate';
import { assertNotAuthor, canAccessPlant } from '@khalta/rbac';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { ApiError, notFound } from '../errors';
import { buildRequestSnapshot, requestBody } from '../optimizer/service';
import {
  checkVersion,
  loadAll,
  pickVersion,
  toView,
  type ExposureCheck,
  type VersionRow,
} from '../profiles/service';
import type { ApiRoutes } from '../route';

const idParam = z.object({ id: z.uuid() });
const versionParam = z.object({ id: z.uuid(), v: z.coerce.number().int().positive() });
const text = (n: number) => z.string().trim().min(1).max(n);

const appliesTo = z.strictObject({
  fcMin: z.number().positive().max(120).optional(),
  fcMax: z.number().positive().max(120).optional(),
  exposure: z.array(z.string().min(1).max(8)).max(12).optional(),
  pumpable: z.boolean().optional(),
  placement: z.enum(PLACEMENTS).optional(),
  season: z.enum(SEASONS).optional(),
});
const content = z.strictObject({
  appliesTo: appliesTo.default({}),
  characteristics: z.unknown().default({}),
  materials: z
    .strictObject({
      include: z.array(z.uuid()).max(200).optional(),
      exclude: z.array(z.uuid()).max(200).optional(),
      prefer: z.array(z.uuid()).max(200).optional(),
    })
    .default({}),
  objective: z.enum(['cheapest', 'closest_to_targets']).nullable().default(null),
  mode: z.enum(['ACI', 'JS', 'BOTH']).nullable().default(null),
  changeNote: z.string().trim().max(500).optional(),
});
const createBody = content.extend({
  scope: z.enum(PROFILE_SCOPES),
  plantId: z.uuid().nullable().default(null),
  nameAr: text(200),
  nameEn: text(200),
  family: z.string().trim().max(120).nullable().default(null),
});
const listQuery = z.object({
  scope: z.enum(PROFILE_SCOPES).optional(),
  plantId: z.uuid().optional(),
});
const matchBody = z.strictObject({
  plantId: z.uuid(),
  fcMpa: z.number().positive().max(120).nullable().default(null),
  exposure: z.array(z.string().min(1).max(8)).max(12).default([]),
  pumpable: z.boolean().nullable().default(null),
  placement: z.enum(PLACEMENTS).nullable().default(null),
  season: z.enum(SEASONS).nullable().default(null),
  /** Profiles the user picked explicitly (overrides automatic selection). */
  profileIds: z.array(z.uuid()).max(3).optional(),
  characteristics: z.unknown().optional(),
  mode: z.enum(['ACI', 'JS', 'BOTH']).default('BOTH'),
});

const visible = (
  auth: { scope: { all: boolean; plantIds: readonly string[] } },
  p: { scope: string; plantId: string | null },
) => p.scope !== 'plant' || (p.plantId !== null && canAccessPlant(auth.scope as never, p.plantId));

export function profileRoutes(api: ApiRoutes) {
  /** The loosening check for a content body, against live rules. */
  async function runCheck(
    tx: Parameters<typeof buildRequestSnapshot>[0],
    tenantId: string,
    plantId: string | null,
    body: { appliesTo: AppliesTo; characteristics: unknown },
  ) {
    const [anyPlant] = plantId
      ? [{ id: plantId }]
      : await tx
          .select({ id: schema.plants.id })
          .from(schema.plants)
          .where(eq(schema.plants.tenantId, tenantId))
          .limit(1);
    if (!anyPlant)
      return { results: [] as ExposureCheck[], ruleVersions: [] as unknown[], ok: true };
    let rules: EvaluationSnapshot['rules'] = [];
    const results = await checkVersion(
      body.appliesTo,
      body.characteristics,
      async (exposure, mode, fc) => {
        const snap = await buildRequestSnapshot(
          tx,
          tenantId,
          requestBody.parse({
            plantId: anyPlant.id,
            mode,
            requirements: { fcMpa: fc, basis: 'cylinder', exposure, slumpMm: 100, nmasMm: 19 },
          }),
        );
        rules = snap.rules;
        return { ...snap, lines: [] };
      },
    );
    return {
      results,
      ruleVersions: rules.map((r) => ({ id: r.id, version: r.version })),
      ok: results.every((r) => r.ok),
    };
  }

  function parseContent(c: z.infer<typeof content>) {
    const m = mergeLayers([
      { level: 'tenant', origin: 'profile', characteristics: c.characteristics },
    ]);
    if (!m.ok)
      throw new ApiError(400, 'characteristics_invalid', 'The characteristics are not valid', {
        invalid: m.errors,
      });
    if (
      c.appliesTo.fcMin !== undefined &&
      c.appliesTo.fcMax !== undefined &&
      c.appliesTo.fcMin > c.appliesTo.fcMax
    )
      throw new ApiError(400, 'invalid_request', 'The strength range is empty');
  }
  const summary = (v: VersionRow) => ({
    version: v.version,
    status: v.status,
    createdAt: v.createdAt,
    approvedAt: v.approvedAt,
    approvedBy: v.approvedBy,
    createdBy: v.createdBy,
    changeNote: v.changeNote,
  });

  api.get(
    '/api/profiles',
    {
      summary: 'Characteristic profiles with their current versions',
      capability: 'design.write',
      query: listQuery,
    },
    async ({ auth, query, db }) => {
      const all = await loadAll(db, auth.tenantId);
      return all
        .filter((x) => visible(auth, x.profile))
        .filter((x) => !query.scope || x.profile.scope === query.scope)
        .filter((x) => !query.plantId || x.profile.plantId === query.plantId)
        .map(({ profile: p, versions }) => {
          const approved = versions.find((v) => v.status === 'approved') ?? null;
          const latest = versions[0]!;
          return {
            id: p.id,
            scope: p.scope,
            plantId: p.plantId,
            nameAr: p.nameAr,
            nameEn: p.nameEn,
            family: p.family,
            latest: summary(latest),
            approved: approved ? summary(approved) : null,
            appliesTo: latest.appliesTo,
            checkOk: (latest.check as { ok?: boolean }).ok ?? null,
          };
        });
    },
  );

  api.get(
    '/api/profiles/:id',
    {
      summary: 'One profile with every version, its check and content',
      capability: 'design.write',
      params: idParam,
    },
    async ({ auth, params, db }) => {
      const hit = (await loadAll(db, auth.tenantId)).find((x) => x.profile.id === params.id);
      if (!hit || !visible(auth, hit.profile)) throw notFound('Profile not found');
      return {
        id: hit.profile.id,
        scope: hit.profile.scope,
        plantId: hit.profile.plantId,
        nameAr: hit.profile.nameAr,
        nameEn: hit.profile.nameEn,
        family: hit.profile.family,
        versions: hit.versions.map((v) => ({
          ...summary(v),
          appliesTo: v.appliesTo,
          characteristics: v.characteristics,
          materials: v.materials,
          objective: v.objective,
          mode: v.rulesetMode,
          check: v.check,
        })),
      };
    },
  );

  api.mutate(
    'post',
    '/api/profiles',
    {
      summary: 'Create a profile with its first DRAFT version',
      capability: 'design.write',
      body: createBody,
      status: 201,
    },
    async ({ auth, body, tx, audit }) => {
      if (body.scope === 'plant') {
        if (!body.plantId || !canAccessPlant(auth.scope, body.plantId))
          throw notFound('Plant not found');
      } else if (body.plantId)
        throw new ApiError(400, 'invalid_request', 'Only a plant profile has a plant');
      parseContent(body);
      const check = await runCheck(tx, auth.tenantId, body.plantId, body);
      const [p] = await tx
        .insert(schema.characteristicProfiles)
        .values({
          tenantId: auth.tenantId,
          scope: body.scope,
          plantId: body.plantId,
          nameAr: body.nameAr,
          nameEn: body.nameEn,
          family: body.family,
          ownerId: auth.user.id,
        })
        .returning();
      const [v] = await tx
        .insert(schema.characteristicProfileVersions)
        .values({
          tenantId: auth.tenantId,
          profileId: p!.id,
          version: 1,
          status: 'draft',
          appliesTo: body.appliesTo,
          characteristics: body.characteristics,
          materials: body.materials,
          objective: body.objective,
          rulesetMode: body.mode,
          changeNote: body.changeNote ?? null,
          check,
          createdBy: auth.user.id,
        })
        .returning();
      await audit.record({
        action: 'profile.create',
        entityType: 'characteristic_profile',
        entityId: p!.id,
        after: {
          scope: body.scope,
          name: body.nameEn,
          version: 1,
          status: 'draft',
          checkOk: check.ok,
        },
      });
      return { id: p!.id, version: v!.version, status: v!.status, check };
    },
  );

  api.mutate(
    'post',
    '/api/profiles/:id/versions',
    {
      summary: 'Create the next version (always a DRAFT; the approved one stays in force)',
      capability: 'design.write',
      params: idParam,
      body: content,
      status: 201,
    },
    async ({ auth, params, body, tx, audit }) => {
      const hit = (await loadAll(tx, auth.tenantId)).find((x) => x.profile.id === params.id);
      if (!hit || !visible(auth, hit.profile)) throw notFound('Profile not found');
      parseContent(body);
      const check = await runCheck(tx, auth.tenantId, hit.profile.plantId, body);
      const next = hit.versions[0]!.version + 1;
      const [v] = await tx
        .insert(schema.characteristicProfileVersions)
        .values({
          tenantId: auth.tenantId,
          profileId: hit.profile.id,
          version: next,
          status: 'draft',
          appliesTo: body.appliesTo,
          characteristics: body.characteristics,
          materials: body.materials,
          objective: body.objective,
          rulesetMode: body.mode,
          changeNote: body.changeNote ?? null,
          check,
          createdBy: auth.user.id,
        })
        .returning();
      await audit.record({
        action: 'profile.version',
        entityType: 'characteristic_profile',
        entityId: hit.profile.id,
        after: { version: next, status: 'draft', checkOk: check.ok },
      });
      return { id: hit.profile.id, version: v!.version, status: v!.status, check };
    },
  );

  api.mutate(
    'post',
    '/api/profiles/:id/versions/:v/approve',
    {
      summary:
        'Approve a draft version (QC manager, not its author); blocked while any covered exposure would be rejected',
      capability: 'profile.approve',
      params: versionParam,
    },
    async ({ auth, params, tx, audit }) => {
      const hit = (await loadAll(tx, auth.tenantId)).find((x) => x.profile.id === params.id);
      if (!hit || !visible(auth, hit.profile)) throw notFound('Profile not found');
      const v = hit.versions.find((x) => x.version === params.v);
      if (!v) throw notFound('Version not found');
      if (v.status === 'approved')
        throw new ApiError(409, 'conflict', 'This version is already approved');
      assertNotAuthor(auth.user.id, v.createdBy);
      const check = await runCheck(tx, auth.tenantId, hit.profile.plantId, {
        appliesTo: v.appliesTo as AppliesTo,
        characteristics: v.characteristics,
      });
      if (!check.ok)
        throw new ApiError(
          409,
          'profile_loosens_limits',
          'This version would be rejected for some exposure classes; fix the values before approving',
          { results: check.results.filter((r) => !r.ok) },
        );
      await tx
        .update(schema.characteristicProfileVersions)
        .set({ status: 'approved', approvedBy: auth.user.id, approvedAt: new Date(), check })
        .where(
          and(
            eq(schema.characteristicProfileVersions.profileId, hit.profile.id),
            eq(schema.characteristicProfileVersions.version, v.version),
          ),
        );
      const older = await usageOf(tx, auth.tenantId, hit.profile.id, v.version);
      await audit.record({
        action: 'profile.approve',
        entityType: 'characteristic_profile',
        entityId: hit.profile.id,
        before: { version: v.version, status: 'draft' },
        after: {
          version: v.version,
          status: 'approved',
          designsOnOlderVersions: older.olderDesigns.length,
        },
      });
      return {
        id: hit.profile.id,
        version: v.version,
        status: 'approved',
        olderVersionDesigns: older.olderDesigns.length,
      };
    },
  );

  api.get(
    '/api/profiles/:id/diff',
    {
      summary: 'Row-level difference between two versions',
      capability: 'design.write',
      params: idParam,
      query: z.object({
        from: z.coerce.number().int().positive(),
        to: z.coerce.number().int().positive(),
      }),
    },
    async ({ auth, params, query, db }) => {
      const hit = (await loadAll(db, auth.tenantId)).find((x) => x.profile.id === params.id);
      if (!hit || !visible(auth, hit.profile)) throw notFound('Profile not found');
      const a = hit.versions.find((x) => x.version === query.from);
      const b = hit.versions.find((x) => x.version === query.to);
      if (!a || !b) throw notFound('Version not found');
      return {
        from: query.from,
        to: query.to,
        rows: diffVersions(toView(hit.profile, a), toView(hit.profile, b)),
      };
    },
  );

  async function usageOf(
    db: Parameters<typeof loadAll>[0],
    tenantId: string,
    profileId: string,
    currentVersion: number,
  ) {
    const designs = await db
      .select({
        id: schema.mixDesigns.id,
        code: schema.mixDesigns.code,
        version: schema.mixDesigns.version,
        status: schema.mixDesigns.status,
        profiles: sql<
          { profileId: string; version: number }[]
        >`${schema.mixDesigns.inputsSnapshot}->'profiles'`,
      })
      .from(schema.mixDesigns)
      .where(
        and(
          eq(schema.mixDesigns.tenantId, tenantId),
          sql`${schema.mixDesigns.inputsSnapshot}->'profiles' @> ${JSON.stringify([{ profileId }])}::jsonb`,
        ),
      );
    const rows = designs.map((d) => ({
      id: d.id,
      code: d.code,
      designVersion: d.version,
      status: d.status,
      profileVersion: (d.profiles ?? []).find((p) => p.profileId === profileId)?.version ?? 0,
    }));
    const [{ n } = { n: 0 }] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.designRequests)
      .where(
        and(
          eq(schema.designRequests.tenantId, tenantId),
          sql`${schema.designRequests.profileVersions} @> ${JSON.stringify([{ profileId }])}::jsonb`,
        ),
      );
    return {
      designs: rows,
      requests: n,
      olderDesigns: rows.filter((r) => r.profileVersion < currentVersion),
    };
  }

  api.get(
    '/api/profiles/:id/usage',
    {
      summary: 'Designs and requests built on this profile, and those on an older version',
      capability: 'design.write',
      params: idParam,
    },
    async ({ auth, params, db }) => {
      const hit = (await loadAll(db, auth.tenantId)).find((x) => x.profile.id === params.id);
      if (!hit || !visible(auth, hit.profile)) throw notFound('Profile not found');
      const approved = hit.versions.find((v) => v.status === 'approved');
      return usageOf(db, auth.tenantId, hit.profile.id, approved?.version ?? 0);
    },
  );

  api.readPost(
    '/api/profiles/match',
    {
      summary:
        'Which profiles match a request, the characteristics they resolve to (with the origin of each value) and the loosening check. Writes nothing',
      capability: 'design.write',
      body: matchBody,
    },
    async ({ auth, body, db }) => {
      if (!canAccessPlant(auth.scope, body.plantId)) throw notFound('Plant not found');
      const all = (await loadAll(db, auth.tenantId)).filter((x) => visible(auth, x.profile));
      const views: ProfileVersionView[] = all.flatMap((x) => {
        const v = pickVersion(x.versions, true);
        return v ? [toView(x.profile, v)] : [];
      });
      const ctx = {
        fcMpa: body.fcMpa,
        exposure: body.exposure,
        pumpable: body.pumpable,
        placement: body.placement,
        season: body.season,
        plantId: body.plantId,
      };
      const explicit = body.profileIds
        ? views.filter((v) => body.profileIds!.includes(v.profileId))
        : null;
      const sel = selectProfiles(views, ctx);
      const chosen = explicit ?? sel.chosen;
      const base = await buildRequestSnapshot(
        db,
        auth.tenantId,
        requestBody.parse({
          plantId: body.plantId,
          mode: body.mode,
          requirements: {
            fcMpa: body.fcMpa ?? 30,
            basis: 'cylinder',
            exposure: body.exposure,
            slumpMm: 100,
            nmasMm: 19,
          },
        }),
      );
      const checked = checkCharacteristics(
        profileLayers(chosen, body.characteristics),
        limitContextFor({ ...base, lines: [] }),
      );
      const chars = checked.characteristics ?? [];
      const brief = (v: ProfileVersionView) => ({
        profileId: v.profileId,
        version: v.version,
        status: v.status,
        scope: v.scope,
        name: v.name,
        family: v.family,
        specificity: specificity(v.appliesTo),
        origin: originOf(v),
      });
      return {
        chosen: chosen.map(brief),
        alsoMatched: (explicit ? [] : sel.alsoMatched).map(brief),
        ties: (explicit ? [] : sel.ties).map((t) => ({
          scope: t.scope,
          candidates: t.candidates.map(brief),
        })),
        defaults: defaultsOf(chosen),
        materials: mergePreferences(chosen, undefined),
        ok: checked.ok,
        rejected: checked.rejected,
        invalid: checked.invalid,
        characteristics: chars.map((c) => ({
          id: idOf(c),
          key: c.key,
          sub: c.sub,
          spec: c.spec,
          origin: c.origin,
        })),
        hasDraft: chosen.some((v) => v.status === 'draft'),
        // exposed for the UI: every profile of the tenant that could match this plant at all
        matchingByScope: views.filter((v) => matches(v, ctx) || explicit !== null).length,
      };
    },
  );
}
