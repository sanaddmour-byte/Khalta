import { sql } from 'drizzle-orm';
import {
  bigserial,
  boolean,
  customType,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';

// Conventions (CLAUDE.md rule 6): no hard deletes. Business rows carry deleted_at (soft delete);
// a DB trigger (migration 0001) rejects DELETE. Property names are camelCase because Better Auth
// resolves its model fields by property name; columns are snake_case.

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
const createdAt = () => ts('created_at').notNull().defaultNow();
const updatedAt = () => ts('updated_at').notNull().defaultNow();

export const tenants = pgTable('tenants', {
  id: uuid('id').primaryKey().defaultRandom(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  createdAt: createdAt(),
});

// ---- Better Auth core tables (+ admin-plugin fields) -------------------------------------------
export const users = pgTable(
  'users',
  {
    id: text('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    name: text('name').notNull(),
    email: text('email').notNull().unique(),
    emailVerified: boolean('email_verified').notNull().default(false),
    image: text('image'),
    role: text('role').notNull().default('viewer'),
    banned: boolean('banned').notNull().default(false),
    banReason: text('ban_reason'),
    banExpires: ts('ban_expires'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    createdBy: text('created_by'),
    deletedAt: ts('deleted_at'),
  },
  (t) => [index('users_tenant_idx').on(t.tenantId)],
);

export const sessions = pgTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    token: text('token').notNull().unique(),
    expiresAt: ts('expires_at').notNull(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    impersonatedBy: text('impersonated_by'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('sessions_user_idx').on(t.userId)],
);

export const accounts = pgTable(
  'accounts',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    accountId: text('account_id').notNull(),
    providerId: text('provider_id').notNull(),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: ts('access_token_expires_at'),
    refreshTokenExpiresAt: ts('refresh_token_expires_at'),
    scope: text('scope'),
    password: text('password'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('accounts_user_idx').on(t.userId)],
);

export const verifications = pgTable('verifications', {
  id: text('id').primaryKey(),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: ts('expires_at').notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

// ---- Organization ------------------------------------------------------------------------------
export const plants = pgTable(
  'plants',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    code: text('code').notNull(), // e.g. AMM-01
    nameAr: text('name_ar').notNull(),
    nameEn: text('name_en').notNull(),
    city: text('city'),
    region: text('region'),
    isActive: boolean('is_active').notNull().default(true),
    ambientProfile: text('ambient_profile', { enum: ['hot', 'moderate'] })
      .notNull()
      .default('moderate'),
    haulCostJodPerM3Km: numeric('haul_cost_jod_per_m3_km', { precision: 12, scale: 3 }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    createdBy: text('created_by').references(() => users.id),
    deletedAt: ts('deleted_at'),
  },
  (t) => [
    uniqueIndex('plants_tenant_code_uq')
      .on(t.tenantId, t.code)
      .where(sql`${t.deletedAt} is null`),
  ],
);

export const userPlants = pgTable(
  'user_plants',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    plantId: uuid('plant_id')
      .notNull()
      .references(() => plants.id),
    createdAt: createdAt(),
    createdBy: text('created_by').references(() => users.id),
    deletedAt: ts('deleted_at'),
  },
  (t) => [
    uniqueIndex('user_plants_active_uq')
      .on(t.userId, t.plantId)
      .where(sql`${t.deletedAt} is null`),
  ],
);

export const suppliers = pgTable('suppliers', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id),
  nameAr: text('name_ar').notNull(),
  nameEn: text('name_en').notNull(),
  contact: text('contact'),
  phone: text('phone'),
  email: text('email'),
  city: text('city'),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
  createdBy: text('created_by').references(() => users.id),
  deletedAt: ts('deleted_at'),
});

export const tenantSettings = pgTable('tenant_settings', {
  tenantId: uuid('tenant_id')
    .primaryKey()
    .references(() => tenants.id),
  settings: jsonb('settings').notNull().default({}),
  updatedAt: updatedAt(),
  updatedBy: text('updated_by').references(() => users.id),
});

// ---- Audit (append-only; enforced by trigger in migration 0001) --------------------------------
export const auditLog = pgTable(
  'audit_log',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    at: ts('at').notNull().defaultNow(),
    actorId: text('actor_id'), // null for system actions
    actorRole: text('actor_role'),
    action: text('action').notNull(),
    entityType: text('entity_type').notNull(),
    entityId: text('entity_id').notNull(),
    before: jsonb('before'),
    after: jsonb('after'),
    requestId: text('request_id'),
  },
  (t) => [
    index('audit_entity_idx').on(t.tenantId, t.entityType, t.entityId),
    index('audit_at_idx').on(t.tenantId, t.at),
  ],
);

// ---- Rules (M0.4) ------------------------------------------------------------------------------
export const rulesets = pgTable(
  'rulesets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    code: text('code').notNull(), // ACI | JS | SHARED | ENGINEERING | EN206 ...
    edition: text('edition').notNull(),
    sourceDoc: text('source_doc'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('rulesets_tenant_code_uq').on(t.tenantId, t.code)],
);

/**
 * One row per rule VERSION. Content never changes in place: an edit inserts a new version
 * (unverified) and supersedes the old one. A trigger rejects content updates (migration 0003).
 */
export const rules = pgTable(
  'rules',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    rulesetId: uuid('ruleset_id')
      .notNull()
      .references(() => rulesets.id),
    key: text('key').notNull(),
    requirement: text('requirement').notNull(),
    version: integer('version').notNull(),
    isCurrent: boolean('is_current').notNull().default(true),
    kind: text('kind').notNull(),
    requirementClass: text('requirement_class').notNull(),
    grp: text('grp'),
    appliesTo: jsonb('applies_to').notNull().default({}),
    prerequisites: jsonb('prerequisites').notNull().default([]),
    value: jsonb('value'), // null = "not on file"
    definition: jsonb('definition'), // table rules
    inherits: text('inherits'),
    units: text('units').notNull(),
    clauseRef: text('clause_ref').notNull(),
    sourceDoc: text('source_doc'),
    validFrom: text('valid_from'),
    validTo: text('valid_to'),
    noteEn: text('note_en'),
    noteAr: text('note_ar'),
    verified: boolean('verified').notNull().default(false),
    verifiedBy: text('verified_by').references(() => users.id),
    verifiedAt: ts('verified_at'),
    origin: text('origin', { enum: ['seed', 'ui', 'csv'] }).notNull(),
    changeReason: text('change_reason'),
    createdAt: createdAt(),
    createdBy: text('created_by').references(() => users.id), // null = seed / system
    supersededAt: ts('superseded_at'),
  },
  (t) => [
    uniqueIndex('rules_version_uq').on(t.tenantId, t.rulesetId, t.key, t.version),
    uniqueIndex('rules_current_uq')
      .on(t.tenantId, t.rulesetId, t.key)
      .where(sql`${t.isCurrent}`),
    index('rules_requirement_idx').on(t.tenantId, t.requirement),
  ],
);

/** Append-only (trigger): who verified which rule version, with the typed e-signature note. */
export const ruleVerifications = pgTable(
  'rule_verifications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    ruleId: uuid('rule_id')
      .notNull()
      .references(() => rules.id),
    verifiedBy: text('verified_by')
      .notNull()
      .references(() => users.id),
    note: text('note').notNull(),
    at: ts('at').notNull().defaultNow(),
  },
  (t) => [index('rule_verifications_rule_idx').on(t.ruleId)],
);

export const ruleImportBatches = pgTable('rule_import_batches', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id),
  kind: text('kind').notNull(), // js_csv
  filename: text('filename'),
  rows: jsonb('rows').notNull(), // validated preview rows, immutable once stored
  summary: jsonb('summary').notNull(),
  status: text('status', { enum: ['previewed', 'committed'] }).notNull(),
  createdBy: text('created_by')
    .notNull()
    .references(() => users.id),
  createdAt: createdAt(),
  committedAt: ts('committed_at'),
});

// ---- Materials (M1.1) --------------------------------------------------------------------------
const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => 'bytea' });

/** Evidence files (lab reports, datasheets) stored in Postgres: ≤ 10 MB, immutable, no hard delete. */
export const attachments = pgTable(
  'attachments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    filename: text('filename').notNull(),
    contentType: text('content_type').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    sha256: text('sha256').notNull(),
    data: bytea('data').notNull(),
    createdAt: createdAt(),
    createdBy: text('created_by').references(() => users.id),
  },
  (t) => [index('attachments_tenant_idx').on(t.tenantId)],
);

/** Tenant-level material; `plantId` is an optional home plant (prices are per plant, M1.2). */
export const materials = pgTable(
  'materials',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    plantId: uuid('plant_id').references(() => plants.id),
    supplierId: uuid('supplier_id').references(() => suppliers.id),
    category: text('category').notNull(), // @khalta/engine CATEGORIES
    marketNameAr: text('market_name_ar'),
    marketNameEn: text('market_name_en').notNull(), // Jordanian market name, e.g. "Adasiyeh"
    technicalName: text('technical_name'),
    sourceName: text('source_name'), // quarry / plant / brand
    notes: text('notes'),
    isActive: boolean('is_active').notNull().default(true),
    /** Set when promoted from an ad-hoc request material. */
    promotedFrom: text('promoted_from'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    createdBy: text('created_by').references(() => users.id),
    deletedAt: ts('deleted_at'),
  },
  (t) => [
    index('materials_tenant_idx').on(t.tenantId, t.category),
    uniqueIndex('materials_tenant_name_uq')
      .on(t.tenantId, t.category, t.marketNameEn)
      .where(sql`${t.deletedAt} is null`),
  ],
);

/**
 * One row per test VERSION of a material. Content never changes in place: a correction inserts a new
 * version and supersedes the old one (trigger in migration 0005). `fieldSources` records the provenance
 * of every property; `source` is the weakest of them.
 */
export const materialTests = pgTable(
  'material_tests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    materialId: uuid('material_id')
      .notNull()
      .references(() => materials.id),
    version: integer('version').notNull(),
    isCurrent: boolean('is_current').notNull().default(true),
    source: text('source', {
      enum: ['lab_report', 'supplier_datasheet', 'user_declared'],
    }).notNull(),
    fieldSources: jsonb('field_sources').notNull().default({}),
    properties: jsonb('properties').notNull(),
    testedAt: date('tested_at', { mode: 'string' }).notNull(),
    validUntil: date('valid_until', { mode: 'string' }),
    labRef: text('lab_ref'),
    attachmentId: uuid('attachment_id').references(() => attachments.id),
    declaredReason: text('declared_reason'),
    declaredBy: text('declared_by').references(() => users.id),
    declaredAt: ts('declared_at'),
    changeReason: text('change_reason'),
    createdAt: createdAt(),
    createdBy: text('created_by').references(() => users.id),
    supersededAt: ts('superseded_at'),
  },
  (t) => [
    uniqueIndex('material_tests_version_uq').on(t.materialId, t.version),
    uniqueIndex('material_tests_current_uq')
      .on(t.materialId)
      .where(sql`${t.isCurrent}`),
    index('material_tests_tenant_idx').on(t.tenantId, t.materialId),
  ],
);

// ---- Prices (M1.2) -----------------------------------------------------------------------------
/**
 * One row per price PERIOD for (material, plant, supplier). Rows are never edited or deleted: a new price
 * closes the previous period (`effective_to`) and a same-day correction supersedes it (`superseded_at`).
 * Only those two columns may change (trigger, migration 0007); live periods never overlap (exclusion constraint).
 */
export const materialPrices = pgTable(
  'material_prices',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    materialId: uuid('material_id')
      .notNull()
      .references(() => materials.id),
    plantId: uuid('plant_id')
      .notNull()
      .references(() => plants.id),
    supplierId: uuid('supplier_id')
      .notNull()
      .references(() => suppliers.id),
    price: numeric('price', { precision: 12, scale: 3 }).notNull(),
    unit: text('unit', { enum: ['JOD/ton', 'JOD/m3', 'JOD/kg', 'JOD/L'] }).notNull(),
    includesDelivery: boolean('includes_delivery').notNull().default(true),
    effectiveFrom: date('effective_from', { mode: 'string' }).notNull(),
    effectiveTo: date('effective_to', { mode: 'string' }),
    supersededAt: ts('superseded_at'),
    reason: text('reason'),
    importBatchId: uuid('import_batch_id'),
    enteredBy: text('entered_by').references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [
    index('material_prices_cell_idx').on(t.tenantId, t.materialId, t.plantId),
    index('material_prices_plant_idx').on(t.tenantId, t.plantId),
  ],
);

/** Which supplier's price a (material, plant) lookup uses when several are priced. */
export const pricePreferences = pgTable(
  'price_preferences',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    materialId: uuid('material_id')
      .notNull()
      .references(() => materials.id),
    plantId: uuid('plant_id')
      .notNull()
      .references(() => plants.id),
    supplierId: uuid('supplier_id')
      .notNull()
      .references(() => suppliers.id),
    updatedAt: updatedAt(),
    updatedBy: text('updated_by').references(() => users.id),
  },
  (t) => [uniqueIndex('price_preferences_cell_uq').on(t.materialId, t.plantId)],
);

/** Immutable, named copy of the prices in force on a date (append-only; migration 0007). */
export const priceSnapshots = pgTable('price_snapshots', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id),
  name: text('name').notNull(),
  asOf: date('as_of', { mode: 'string' }).notNull(),
  plantIds: jsonb('plant_ids').notNull(),
  lineCount: integer('line_count').notNull(),
  contentHash: text('content_hash').notNull(),
  createdBy: text('created_by').references(() => users.id),
  createdAt: createdAt(),
});

export const priceSnapshotLines = pgTable(
  'price_snapshot_lines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    snapshotId: uuid('snapshot_id')
      .notNull()
      .references(() => priceSnapshots.id),
    materialId: uuid('material_id').notNull(),
    plantId: uuid('plant_id').notNull(),
    supplierId: uuid('supplier_id'),
    priceId: uuid('price_id'),
    status: text('status', {
      enum: ['ok', 'unavailable', 'ambiguous', 'not_convertible'],
    }).notNull(),
    price: numeric('price', { precision: 12, scale: 3 }),
    unit: text('unit'),
    includesDelivery: boolean('includes_delivery'),
    effectiveFrom: date('effective_from', { mode: 'string' }),
    jodPerKg: numeric('jod_per_kg', { precision: 18, scale: 9 }),
    note: text('note'),
  },
  (t) => [index('price_snapshot_lines_snapshot_idx').on(t.snapshotId)],
);

export const priceImportBatches = pgTable('price_import_batches', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id),
  filename: text('filename'),
  rows: jsonb('rows').notNull(),
  summary: jsonb('summary').notNull(),
  status: text('status', { enum: ['previewed', 'committed'] }).notNull(),
  createdBy: text('created_by')
    .notNull()
    .references(() => users.id),
  createdAt: createdAt(),
  committedAt: ts('committed_at'),
});

// ---- Designs and legacy import (M1.3) ----------------------------------------------------------
export const DESIGN_STATUSES = [
  'draft',
  'evaluated',
  'trial_candidate',
  'trial_in_progress',
  'trial_passed',
  'approved',
  'in_production',
  'suspended',
  'superseded',
  'retired',
] as const;

/** The uploaded table, kept so mapping and matching can be redone without re-uploading. */
export const legacyImportBatches = pgTable('legacy_import_batches', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id),
  filename: text('filename'),
  rows: jsonb('rows').notNull(), // string[][] without the header
  header: jsonb('header').notNull(), // string[]
  status: text('status', { enum: ['uploaded', 'committed'] }).notNull(),
  summary: jsonb('summary'),
  createdBy: text('created_by')
    .notNull()
    .references(() => users.id),
  createdAt: createdAt(),
  committedAt: ts('committed_at'),
});

/**
 * A mix design. Imported inputs (code, plant, requirements, lines, snapshot) never change in place;
 * only status and approval bookkeeping do (trigger, migration 0009).
 */
export const mixDesigns = pgTable(
  'mix_designs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    code: text('code').notNull(),
    name: text('name').notNull(),
    plantId: uuid('plant_id')
      .notNull()
      .references(() => plants.id),
    version: integer('version').notNull().default(1),
    status: text('status', { enum: DESIGN_STATUSES }).notNull().default('draft'),
    approvalSource: text('approval_source', { enum: ['khalta', 'legacy_attested'] }),
    externalApprovalRef: text('external_approval_ref'),
    approvedBy: text('approved_by').references(() => users.id),
    approvedAt: ts('approved_at'),
    rulesetMode: text('ruleset_mode'),
    requirements: jsonb('requirements').notNull(),
    inputsSnapshot: jsonb('inputs_snapshot').notNull(),
    /** What the file said (not an approval): reference, "in production" flag, average volume. */
    importedApprovalRef: text('imported_approval_ref'),
    importedInProduction: boolean('imported_in_production'),
    avgMonthlyVolumeM3: numeric('avg_monthly_volume_m3', { precision: 12, scale: 2 }),
    evaluationPending: boolean('evaluation_pending').notNull().default(true),
    warnings: jsonb('warnings').notNull().default([]),
    /** Raised when an evaluation of an already-attested design fails a hard check (bookkeeping, not an input). */
    needsRevalidation: boolean('needs_revalidation').notNull().default(false),
    /** The latest stored evaluation (denormalized for the Library list). */
    lastEvaluationId: uuid('last_evaluation_id').references(
      (): AnyPgColumn => designEvaluations.id,
    ),
    lastVerdict: text('last_verdict', { enum: ['fail', 'incomplete', 'pass'] }),
    lastEvaluatedAt: ts('last_evaluated_at'),
    importBatchId: uuid('import_batch_id').references(() => legacyImportBatches.id),
    synthetic: boolean('synthetic').notNull().default(false),
    parentDesignId: uuid('parent_design_id'),
    /** The optimizer candidate this design was created from (set once, at insert). */
    sourceCandidateId: uuid('source_candidate_id').references(
      (): AnyPgColumn => designCandidates.id,
    ),
    createdBy: text('created_by').references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: ts('deleted_at'),
  },
  (t) => [
    uniqueIndex('mix_designs_code_uq')
      .on(t.tenantId, t.code, t.version)
      .where(sql`${t.deletedAt} is null`),
    index('mix_designs_plant_idx').on(t.tenantId, t.plantId, t.status),
  ],
);

export const mixDesignLines = pgTable(
  'mix_design_lines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    designId: uuid('design_id')
      .notNull()
      .references(() => mixDesigns.id),
    materialId: uuid('material_id')
      .notNull()
      .references(() => materials.id),
    /** Per m³ SSD in kg (litres converted through SG at import time). */
    quantityKgM3: numeric('quantity_kg_m3', { precision: 12, scale: 3 }).notNull(),
    originalQuantity: numeric('original_quantity', { precision: 12, scale: 3 }).notNull(),
    originalUnit: text('original_unit', { enum: ['kg/m3', 'L/m3'] }).notNull(),
    originalName: text('original_name').notNull(),
    sourceLine: integer('source_line'),
    matchMethod: text('match_method', { enum: ['exact', 'confirmed', 'created'] }).notNull(),
  },
  (t) => [index('mix_design_lines_design_idx').on(t.designId)],
);

/** Append-only history of every state change, with the evidence named (trigger, migration 0009). */
/**
 * Every evaluation of a design, stored whole and never changed: the exact snapshot it was computed from,
 * the report, and the independent validator's result. A newer evaluation never overwrites an older one.
 */
export const designEvaluations = pgTable(
  'design_evaluations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    designId: uuid('design_id')
      .notNull()
      .references(() => mixDesigns.id),
    mode: text('mode', { enum: ['ACI', 'JS', 'BOTH'] }).notNull(),
    snapshot: jsonb('snapshot').notNull(),
    report: jsonb('report').notNull(),
    validator: jsonb('validator').notNull(),
    validatorStatus: text('validator_status', { enum: ['pass', 'fail'] }).notNull(),
    verdict: text('verdict', { enum: ['fail', 'incomplete', 'pass'] }).notNull(),
    provisional: boolean('provisional').notNull(),
    minimumDataOk: boolean('minimum_data_ok').notNull(),
    costJodPerM3: numeric('cost_jod_per_m3', { precision: 12, scale: 3 }),
    priceBasis: jsonb('price_basis').notNull(),
    /** [{ id, version }] of every rule the evaluation used. */
    ruleVersions: jsonb('rule_versions').notNull(),
    /** { failing, unevaluated, blockers, provisional, evidence, quality[] } for the portfolio views. */
    summary: jsonb('summary').notNull().default({}),
    /** materialId → test version the evaluation used (to show "inputs changed" without recomputing). */
    testVersions: jsonb('test_versions').notNull().default({}),
    evaluatorVersion: text('evaluator_version').notNull(),
    validatorVersion: text('validator_version').notNull(),
    createdBy: text('created_by').references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [index('design_evaluations_design_idx').on(t.designId, t.createdAt)],
);

export const designTransitions = pgTable(
  'design_transitions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    designId: uuid('design_id')
      .notNull()
      .references(() => mixDesigns.id),
    fromStatus: text('from_status').notNull(),
    toStatus: text('to_status').notNull(),
    actorId: text('actor_id').references(() => users.id),
    evidence: jsonb('evidence').notNull(),
    at: ts('at').notNull().defaultNow(),
  },
  (t) => [index('design_transitions_design_idx').on(t.designId)],
);

export const productionVolumes = pgTable(
  'production_volumes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    designId: uuid('design_id')
      .notNull()
      .references(() => mixDesigns.id),
    plantId: uuid('plant_id')
      .notNull()
      .references(() => plants.id),
    month: date('month', { mode: 'string' }).notNull(), // first day of the month
    volumeM3: numeric('volume_m3', { precision: 12, scale: 2 }).notNull(),
    source: text('source', { enum: ['demo', 'import', 'batch_tickets'] }).notNull(),
  },
  (t) => [uniqueIndex('production_volumes_uq').on(t.designId, t.month)],
);

/**
 * A cost baseline: what one attested design costs per m³ at one named, immutable price snapshot, from one
 * stored evaluation. Never re-priced; later comparisons use the same snapshot (01-domain §14.2).
 */
export const costBaselines = pgTable(
  'cost_baselines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    designId: uuid('design_id')
      .notNull()
      .references(() => mixDesigns.id),
    evaluationId: uuid('evaluation_id')
      .notNull()
      .references(() => designEvaluations.id),
    priceSnapshotId: uuid('price_snapshot_id')
      .notNull()
      .references(() => priceSnapshots.id),
    plantId: uuid('plant_id')
      .notNull()
      .references(() => plants.id),
    costJodPerM3: numeric('cost_jod_per_m3', { precision: 12, scale: 3 }).notNull(),
    /** The stated average from the legacy file; an estimate, not a production record. */
    monthlyVolumeM3: numeric('monthly_volume_m3', { precision: 12, scale: 2 }),
    volumeSource: text('volume_source', { enum: ['import_file'] }),
    annualJod: numeric('annual_jod', { precision: 16, scale: 3 }),
    createdBy: text('created_by').references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('cost_baselines_design_snapshot_uq').on(t.designId, t.priceSnapshotId)],
);

// ---- Characteristic profiles (M3.3) ---------------------------------------------------------------

/** A named way of making a product. The content lives in immutable versions. */
export const characteristicProfiles = pgTable(
  'characteristic_profiles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    scope: text('scope', { enum: ['tenant', 'plant', 'product_family'] }).notNull(),
    plantId: uuid('plant_id').references(() => plants.id),
    nameAr: text('name_ar').notNull(),
    nameEn: text('name_en').notNull(),
    /** Free-text product family label (matching uses `applies_to`, not this). */
    family: text('family'),
    ownerId: text('owner_id').references(() => users.id),
    createdAt: createdAt(),
    deletedAt: ts('deleted_at'),
  },
  (t) => [index('characteristic_profiles_tenant_idx').on(t.tenantId, t.scope)],
);

/** One version of a profile. Content never changes; only a draft can become approved (once). */
export const characteristicProfileVersions = pgTable(
  'characteristic_profile_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    profileId: uuid('profile_id')
      .notNull()
      .references(() => characteristicProfiles.id),
    version: integer('version').notNull(),
    status: text('status', { enum: ['draft', 'approved'] })
      .notNull()
      .default('draft'),
    appliesTo: jsonb('applies_to').notNull(),
    characteristics: jsonb('characteristics').notNull(),
    materials: jsonb('materials').notNull(),
    objective: text('objective', { enum: ['cheapest', 'closest_to_targets'] }),
    rulesetMode: text('ruleset_mode', { enum: ['ACI', 'JS', 'BOTH'] }),
    changeNote: text('change_note'),
    /** The loosening check against every exposure in `applies_to`, with the rule versions it used. */
    check: jsonb('check').notNull(),
    createdBy: text('created_by').references(() => users.id),
    createdAt: createdAt(),
    approvedBy: text('approved_by').references(() => users.id),
    approvedAt: ts('approved_at'),
  },
  (t) => [uniqueIndex('characteristic_profile_versions_uq').on(t.profileId, t.version)],
);

/**
 * One optimizer request: the inputs, the exact snapshot (rules versions, materials, prices) it ran on, and the
 * outcome (candidates, blockers, conflicts, degrees of freedom). Immutable: a re-run is a new request.
 */
export const designRequests = pgTable(
  'design_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    plantId: uuid('plant_id')
      .notNull()
      .references(() => plants.id),
    mode: text('mode', { enum: ['ACI', 'JS', 'BOTH'] }).notNull(),
    objective: text('objective', { enum: ['cheapest', 'closest_to_targets'] }).notNull(),
    /** The strength / exposure / slump / NMAS request, as the evaluator reads it. */
    request: jsonb('request').notNull(),
    /** The user's characteristics and material include/exclude lists, as submitted. */
    inputs: jsonb('inputs').notNull(),
    /** The evaluation snapshot minus proportions: rules, materials, prices, settings. */
    snapshot: jsonb('snapshot').notNull(),
    status: text('status', {
      enum: ['candidates', 'blocked', 'infeasible', 'no_valid_candidate'],
    }).notNull(),
    /** { blockers, conflicts, dof, stats, excluded, notes } */
    outcome: jsonb('outcome').notNull(),
    optimizerVersion: text('optimizer_version').notNull(),
    solver: text('solver').notNull(),
    /** [{ profileId, version }] applied to this request, and the origin of each resolved characteristic. */
    profileVersions: jsonb('profile_versions').notNull().default([]),
    profileOrigins: jsonb('profile_origins').notNull().default({}),
    createdBy: text('created_by').references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [index('design_requests_plant_idx').on(t.tenantId, t.plantId, t.createdAt)],
);

/** One ranked candidate of a request. Never edited; turning it into a design creates a new draft design. */
export const designCandidates = pgTable(
  'design_candidates',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    requestId: uuid('request_id')
      .notNull()
      .references(() => designRequests.id),
    rank: integer('rank').notNull(),
    configuration: jsonb('configuration').notNull(),
    lines: jsonb('lines').notNull(),
    report: jsonb('report').notNull(),
    /** The request and rounding tolerances that, with `lines`, rebuild the exact snapshot the candidate was judged on. */
    overrides: jsonb('overrides').notNull(),
    guardrails: jsonb('guardrails').notNull(),
    margins: jsonb('margins').notNull(),
    binding: jsonb('binding').notNull(),
    characteristics: jsonb('characteristics').notNull(),
    deviations: jsonb('deviations').notNull(),
    notes: jsonb('notes').notNull(),
    evidence: jsonb('evidence').notNull(),
    /** MODEL_PREDICTS_SHORTFALL present: a QC manager must authorise before it can become a trial candidate. */
    requiresAuthorization: boolean('requires_authorization').notNull(),
    costJodPerM3: numeric('cost_jod_per_m3', { precision: 12, scale: 3 }),
    objectiveValue: numeric('objective_value', { precision: 14, scale: 6 }).notNull(),
    /** Result of the independent candidate validator at creation. Only `pass` candidates are stored. */
    validator: jsonb('validator').notNull(),
    validatorStatus: text('validator_status', { enum: ['pass', 'fail'] }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('design_candidates_request_rank_uq').on(t.requestId, t.rank)],
);

/** Ledger entries. Only `theoretical` exists until trials, approval and production volumes do (M4.x, M5.1). */
export const savingsEntries = pgTable(
  'savings_entries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    baselineId: uuid('baseline_id')
      .notNull()
      .references(() => costBaselines.id),
    baselineDesignId: uuid('baseline_design_id')
      .notNull()
      .references(() => mixDesigns.id),
    variantDesignId: uuid('variant_design_id')
      .notNull()
      .references(() => mixDesigns.id),
    variantEvaluationId: uuid('variant_evaluation_id')
      .notNull()
      .references(() => designEvaluations.id),
    /** The SAME snapshot prices both designs, so market movement is never credited to the change. */
    priceSnapshotId: uuid('price_snapshot_id')
      .notNull()
      .references(() => priceSnapshots.id),
    state: text('state', { enum: ['theoretical'] })
      .notNull()
      .default('theoretical'),
    reasonCode: text('reason_code', { enum: ['manual_variant'] }).notNull(),
    savingJodPerM3: numeric('saving_jod_per_m3', { precision: 12, scale: 3 }).notNull(),
    monthlyVolumeM3: numeric('monthly_volume_m3', { precision: 12, scale: 2 }),
    annualJod: numeric('annual_jod', { precision: 16, scale: 3 }),
    /** True while any rule used is unverified (always, until QC verifies the rules). */
    provisional: boolean('provisional').notNull(),
    createdBy: text('created_by').references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('savings_entries_variant_eval_uq').on(t.baselineId, t.variantEvaluationId)],
);
