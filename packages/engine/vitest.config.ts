import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // the optimizer's end-to-end tests run a real LP solver many times
    testTimeout: 60_000,
    coverage: {
      include: ['src/**/*.ts'],
      exclude: ['src/testing/**'],
      thresholds: { lines: 90, functions: 90, branches: 90, statements: 90 },
    },
  },
});
