import { sql } from 'drizzle-orm';
import {
  bigserial,
  boolean,
  index,
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
