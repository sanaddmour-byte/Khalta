import { defineConfig } from '@playwright/test';
import base from './playwright.config';

// The base config splits the e2e specs into projects; screenshots use one project that matches `*.screens.ts`.
export default defineConfig({
  ...base,
  projects: [{ name: 'screens', testMatch: /.*\.screens\.ts/ }],
});
