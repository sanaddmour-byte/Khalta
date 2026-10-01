# ADR 0003 — Audit mechanism

Status: accepted (M0.2)

## Context

Every mutation must be audited (CLAUDE.md rule 6) and the log must be trustworthy: no silent gaps, no after-the-fact edits.

## Alternatives

1. **Database triggers writing audit rows.** Cannot know the acting user or request without session variables; hard to produce before/after in the domain's terms.
2. **Application-level audit in the same transaction as the change (chosen), plus database triggers that make the log append-only.**
3. **Event/outbox or external audit service.** Eventual consistency means a change can exist without its audit row.

## Decision

- All mutating routes are declared through `ApiRoutes.mutate`, which wraps the handler in `withAudit`: one transaction containing the change and its `audit_log` rows. Handler failure rolls back both; a handler that records **no** audit entry is rejected (`AuditMissingError`) and rolled back, so a route cannot forget auditing.
- An audit row stores tenant, timestamp, actor id and role (null = system), action, entity type/id, before/after JSON and the request id. Secrets (passwords) are never recorded.
- `audit_log` is append-only in PostgreSQL: row triggers reject `UPDATE`/`DELETE`, a statement trigger rejects `TRUNCATE`.
- Business tables reject `DELETE` by trigger (soft delete via `deleted_at`).
- A test walks the Express router and fails if any non-GET route (other than the Better Auth handler) is not registered through the audited helper.
- Retention: forever. Partition by month only if volume demands it.

## Evidence

`audit.test.ts`: one correct row per mutation, nothing on rejected requests, rollback on handler failure/missing audit/failing audit insert, router enumeration, trigger rejection of UPDATE/DELETE/TRUNCATE.

## Risks

- A superuser or the table owner can drop the triggers. Production should run the app as a role without `TRIGGER`/`DDL` privileges and with only `INSERT, SELECT` on `audit_log` (to be set up in M6.2 runbooks).
- Better Auth's own writes (sessions) are not business mutations and are not audited. Sign-in events may be added later.

## Reversal path

The helper is the single choke point: switching to an outbox or trigger-based approach changes `withAudit` only.
