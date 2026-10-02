// Characteristic profiles: loading versions, resolving the layers a request uses, and the loosening check a
// version must pass (for every exposure it covers, against ACI and JS) before it can be approved.
import { schema, type Executor } from '@khalta/db';
import { checkCharacteristics, type AppliesTo, type ProfileVersionView } from '@khalta/engine';
import { limitContextFor } from '@khalta/engine/evaluate';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { ApiError } from '../errors';

export type VersionRow = typeof schema.characteristicProfileVersions.$inferSelect;
export type ProfileRow = typeof schema.characteristicProfiles.$inferSelect;

export const toView = (p: ProfileRow, v: VersionRow): ProfileVersionView => ({
  profileId: p.id,
  version: v.version,
  status: v.status,
  scope: p.scope,
  plantId: p.plantId,
  name: p.nameEn,
  family: p.family,
  appliesTo: v.appliesTo as AppliesTo,
  characteristics: v.characteristics,
  materials: v.materials as ProfileVersionView['materials'],
  objective: v.objective,
  mode: v.rulesetMode,
  createdAt: v.createdAt.toISOString(),
});

/** Every non-deleted profile with all its versions (newest version first). */
export async function loadAll(db: Executor, tenantId: string) {
  const profiles = await db
    .select()
    .from(schema.characteristicProfiles)
    .where(
      and(
        eq(schema.characteristicProfiles.tenantId, tenantId),
        isNull(schema.characteristicProfiles.deletedAt),
      ),
    );
  const versions = profiles.length
    ? await db
        .select()
        .from(schema.characteristicProfileVersions)
        .where(
          and(
            eq(schema.characteristicProfileVersions.tenantId, tenantId),
            inArray(
              schema.characteristicProfileVersions.profileId,
              profiles.map((p) => p.id),
            ),
          ),
        )
    : [];
  return profiles.map((p) => ({
    profile: p,
    versions: versions.filter((v) => v.profileId === p.id).sort((a, b) => b.version - a.version),
  }));
}

/** The version a request uses: the newest approved one; for previews, else the newest draft. */
export function pickVersion(versions: VersionRow[], allowDraft: boolean): VersionRow | null {
  return (
    versions.find((v) => v.status === 'approved') ?? (allowDraft ? (versions[0] ?? null) : null)
  );
}

export interface AppliedProfiles {
  chosen: ProfileVersionView[];
  versions: { profileId: string; version: number; status: 'draft' | 'approved' }[];
}

/**
 * Resolves the profile ids a request names. Trial generation needs APPROVED versions; previews and evaluations
 * may use a draft. A plant profile only applies at its own plant; one profile per scope.
 */
export async function applyProfiles(
  db: Executor,
  tenantId: string,
  plantId: string,
  ids: string[] | undefined,
  forGeneration: boolean,
): Promise<AppliedProfiles> {
  if (!ids || ids.length === 0) return { chosen: [], versions: [] };
  const all = await loadAll(db, tenantId);
  const chosen: ProfileVersionView[] = [];
  for (const id of ids) {
    const hit = all.find((x) => x.profile.id === id);
    if (!hit) throw new ApiError(404, 'not_found', 'Profile not found');
    if (hit.profile.scope === 'plant' && hit.profile.plantId !== plantId)
      throw new ApiError(409, 'conflict', 'A plant profile applies only at its own plant');
    const v = pickVersion(hit.versions, !forGeneration);
    if (!v)
      throw new ApiError(
        409,
        'profile_draft',
        `Profile "${hit.profile.nameEn}" has no approved version; a QC manager must approve it before it can drive a trial recommendation`,
      );
    if (forGeneration && v.status !== 'approved')
      throw new ApiError(
        409,
        'profile_draft',
        'Only approved profile versions can drive a trial recommendation',
      );
    chosen.push(toView(hit.profile, v));
  }
  const scopes = chosen.map((c) => c.scope);
  if (new Set(scopes).size !== scopes.length)
    throw new ApiError(400, 'invalid_request', 'Choose at most one profile per scope');
  const order = { tenant: 0, plant: 1, product_family: 2 } as const;
  chosen.sort((a, b) => order[a.scope] - order[b.scope]);
  return {
    chosen,
    versions: chosen.map((c) => ({ profileId: c.profileId, version: c.version, status: c.status })),
  };
}

export interface ExposureCheck {
  exposure: string;
  mode: 'ACI' | 'JS';
  ok: boolean;
  rejected: unknown[];
}

/**
 * The loosening check: the version's characteristics against ACI and JS for each exposure class it covers
 * (or one open request when it names none). The caller supplies a snapshot builder so rules and materials come
 * from the live tenant.
 */
export async function checkVersion(
  appliesTo: AppliesTo,
  characteristics: unknown,
  snapshotFor: (
    exposure: string[],
    mode: 'ACI' | 'JS',
    fc: number,
  ) => Promise<Parameters<typeof limitContextFor>[0]>,
): Promise<ExposureCheck[]> {
  const classes = appliesTo.exposure && appliesTo.exposure.length > 0 ? appliesTo.exposure : [''];
  const fc = appliesTo.fcMin ?? appliesTo.fcMax ?? 30;
  const out: ExposureCheck[] = [];
  for (const cls of classes)
    for (const mode of ['ACI', 'JS'] as const) {
      const snap = await snapshotFor(cls ? [cls] : [], mode, fc);
      const r = checkCharacteristics(
        [{ level: 'request', origin: 'profile', characteristics: characteristics ?? {} }],
        limitContextFor(snap),
      );
      out.push({
        exposure: cls,
        mode,
        ok: r.ok,
        rejected: [...r.invalid, ...r.rejected],
      });
    }
  return out;
}
