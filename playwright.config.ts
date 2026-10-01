import { defineConfig } from '@playwright/test';

// Sandboxes ship a pre-installed Chromium; CI installs its own. Never download here.
const executablePath = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'];

export default defineConfig({
  testDir: 'e2e',
  testMatch: /.*\.e2e\.ts/,
  reporter: 'list',
  use: {
    baseURL: 'http://localhost:5173',
    launchOptions: executablePath ? { executablePath } : {},
  },
  webServer: {
    command: 'pnpm --filter @khalta/web dev',
    url: 'http://localhost:5173',
    reuseExistingServer: !process.env['CI'],
  },
});
