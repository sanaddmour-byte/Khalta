import { defineConfig } from '@playwright/test';
import { E2E_DATABASE_URL, E2E_SECRET } from './e2e/env';

// Sandboxes ship a pre-installed Chromium; CI installs its own. Never download here.
const executablePath = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'];

export default defineConfig({
  testDir: 'e2e',
  testMatch: /.*\.e2e\.ts/,
  reporter: 'list',
  workers: 2,
  timeout: 30_000,
  use: {
    baseURL: 'http://localhost:5173',
    launchOptions: executablePath ? { executablePath } : {},
  },
  webServer: [
    {
      // Fresh database + dev seed, then the real API (NODE_ENV=test disables sign-in rate limiting).
      command: 'node e2e/prepare-db.mjs && pnpm --filter @khalta/api exec tsx src/server.ts',
      url: 'http://localhost:3000/health',
      timeout: 120_000,
      reuseExistingServer: !process.env['CI'],
      env: {
        DATABASE_URL: E2E_DATABASE_URL,
        NODE_ENV: 'test',
        PORT: '3000',
        BETTER_AUTH_SECRET: E2E_SECRET,
        BETTER_AUTH_URL: 'http://localhost:3000',
        APP_BASE_URL: 'http://localhost:5173',
        LOG_LEVEL: 'warn',
      },
    },
    {
      command: 'pnpm --filter @khalta/web dev',
      url: 'http://localhost:5173',
      reuseExistingServer: !process.env['CI'],
    },
  ],
});
