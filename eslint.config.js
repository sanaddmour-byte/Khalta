import js from '@eslint/js';
import khalta from '@khalta/eslint-plugin';
import prettier from 'eslint-config-prettier';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const uiFiles = ['apps/web/src/**/*.{ts,tsx}', 'packages/ui/src/**/*.{ts,tsx}'];

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/coverage/**',
      '**/.turbo/**',
      '**/playwright-report/**',
      '**/test-results/**',
      'tools/boundaries/fixtures/**',
      'docs/screens/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  { languageOptions: { globals: { ...globals.node } } },
  {
    files: uiFiles,
    plugins: { khalta },
    languageOptions: { globals: { ...globals.browser } },
    rules: { 'khalta/no-hardcoded-ui-strings': 'error', 'khalta/no-physical-css': 'error' },
  },
  {
    files: ['packages/validator/**/*.{ts,tsx}'],
    plugins: { khalta },
    rules: { 'khalta/validator-isolation': 'error' },
  },
);
