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
