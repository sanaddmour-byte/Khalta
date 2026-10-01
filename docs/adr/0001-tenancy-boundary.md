# ADR 0001 — Tenancy boundary

Status: accepted (M0.2)

## Context

Khalta serves one Jordanian producer in v1 but the spec requires "multi-tenant ready". We must decide how much tenancy machinery to build now.

## Alternatives

1. **Single tenant, no tenant column.** Simplest; retrofitting a column later touches every table and every query.
2. **Single tenant in practice, `tenant_id` on every business table, all queries tenant-filtered (chosen).** One `tenants` row; every query takes the tenant from the authenticated context.
3. **Full multi-tenancy now** (subdomain routing, per-tenant config, Postgres row-level security). Highest cost, nothing needs it yet.

## Decision

Option 2. Every business table carries `tenant_id` (FK to `tenants`). The tenant comes only from the authenticated user's row, never from request input. All reads and writes filter on it; the audit log is tenant-scoped. There is no tenant routing and no tenant-management API; `bootstrap` creates the single tenant.

## Evidence

`settings-tenancy.test.ts` ("tenant isolation") seeds a second tenant and proves its plants, users and audit rows are invisible and untouchable (404) from the first, and that cross-tenant plant assignment is refused.

## Risks

- A forgotten tenant filter leaks data. Mitigation: route helpers receive the auth context, tests cover every route family; PostgreSQL row-level security is the reversal/hardening path if a second tenant is ever onboarded.
- Unique constraints are per tenant (`plants (tenant_id, code)`), but `users.email` is globally unique because Better Auth looks users up by email alone. Revisit if tenants must share an email address.

## Reversal path

Drop to option 1 by ignoring the column (cheap). Move to option 3 by adding RLS policies keyed on a per-request `SET LOCAL khalta.tenant_id`, with no schema change.
