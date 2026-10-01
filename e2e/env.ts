// Shared by playwright.config.ts and e2e/prepare-db.mjs: where the e2e database lives.
const admin = process.env['TEST_DATABASE_URL'] ?? 'postgres://postgres@127.0.0.1:55432/postgres';
const u = new URL(admin);
u.pathname = '/khalta_e2e';
export const E2E_ADMIN_URL = admin;
export const E2E_DATABASE_URL = u.toString();
export const E2E_SECRET = 'e2e-secret-e2e-secret-e2e-secret-1234';
