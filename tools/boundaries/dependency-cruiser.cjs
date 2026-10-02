// Transitive guard behind the validator-isolation ESLint rule: no path from packages/validator
// to the engine optimizer, including via barrel files or other packages.
/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'validator-must-not-reach-optimizer',
      severity: 'error',
      comment: 'packages/validator must stay independent of optimizer code (safety contract #4).',
      from: { path: 'packages/validator/' },
      to: { path: 'packages/engine/src/optimizer/', reachable: true },
    },
    {
      name: 'validator-must-not-reach-evaluator',
      severity: 'error',
      comment:
        'The validator is a second implementation: it may read the evaluation types, never the evaluator calculation modules (ADR 0007).',
      from: { path: '^packages/validator/src' },
      to: { path: '^packages/engine/src/evaluate/(?!types\\.ts$)', reachable: true },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    tsConfig: { fileName: 'tsconfig.base.json' },
    tsPreCompilationDeps: true,
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default'],
    },
    exclude: { path: '(^|/)(fixtures|dist|coverage)/' },
  },
};
