# ADR 0002 — Authentication and session strategy

Status: accepted (M0.2)

## Context

Auth must never be hand-rolled (stack rule). Users are created by an Admin; roles, plant scope and tenancy are Khalta concepts that must stay under our audit trail.

## Alternatives

1. **Better Auth with its admin plugin** handling user creation, roles and bans. Fastest, but its admin HTTP endpoints mutate users outside our audit transaction and use its own role model.
2. **Better Auth for credentials/sessions only; users, roles, plants are our tables and our audited routes (chosen).**
3. **Another library** (Lucia is deprecated; Auth.js targets OAuth flows). Rejected: the spec names Better Auth.

## Decision

- Better Auth provides email+password sign-in, session cookies (httpOnly, SameSite=Lax, Secure when served over https), password hashing and rate limiting (on outside tests).
- **Only three Better Auth endpoints are reachable**: `sign-in/email`, `sign-out`, `get-session`. Everything else (sign-up, admin plugin, password reset, change-email) answers 404 at the Express layer. Public sign-up is also disabled inside Better Auth (defence in depth).
- Users and credential accounts are inserted by our own code inside the audited transaction, using Better Auth's password hasher so credentials verify through its normal sign-in.
- The session identifies the user; **role, tenant, plant scope and settings are loaded from our tables on every request**. Role changes, plant reassignment and deactivation therefore take effect immediately without stale session claims.
- Sessions last 7 days, refreshed daily. Passwords: 12–128 characters, no composition rules. Deactivated (soft-deleted/banned) users cannot open a session (database hook) and their open sessions are deleted.
- Browser mutations carrying an `Origin` header must match our app origin; non-browser clients send none.
- `BETTER_AUTH_SECRET` (≥ 32 chars) is required in every environment; there is no fallback.
- First admin: `BOOTSTRAP_ADMIN_EMAIL`/`BOOTSTRAP_ADMIN_PASSWORD`, used only while the users table is empty, audited as a system action.

## Evidence

`auth.test.ts`: unauthenticated 401s, cookie flags, identical failure for wrong password and unknown user, sign-out, closed endpoints, expired sessions, origin guard. `integrity.test.ts`: deactivation, password reset and last-admin protection.

## Risks

- Better Auth's internal schema or endpoint names may change on upgrade. Mitigation: pinned version, the allowlist, and tests that sign in through the real handler.
- We depend on `auth.$context.password.hash` for hashing, which is part of Better Auth's documented context API.
- Self-service password change and email-based reset are intentionally absent until an email provider exists; Admins reset passwords.

## Reversal path

Replace the sign-in handler behind the same `authenticate` middleware; our tables and audit trail do not depend on Better Auth beyond the `users`/`accounts` columns it requires.
