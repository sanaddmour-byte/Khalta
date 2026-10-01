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
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
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
  {
    // CLAUDE.md rule 6: no hard deletes. Only Better Auth's own tables may be deleted from.
    files: ['apps/api/src/**/*.ts', 'packages/db/src/**/*.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "CallExpression[callee.property.name='delete'][arguments.0.type='MemberExpression'][arguments.0.object.name='schema']:not([arguments.0.property.name=/^(sessions|accounts|verifications)$/])",
          message: 'No hard deletes on business tables: set deleted_at (soft delete) instead.',
        },
      ],
    },
  },
);
