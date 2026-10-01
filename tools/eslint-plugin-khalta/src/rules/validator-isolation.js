// The validator must be independent of the optimizer. This catches direct imports of any module path
// containing an "optimizer" segment; tools/boundaries (dependency-cruiser) catches transitive/barrel
// paths. Apply only to packages/validator via eslint config.
const OPTIMIZER_SEGMENT = /(^|[/\\@.-])optimizer($|[/\\.-])/i;

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'problem',
    messages: { banned: 'validator must not import optimizer code ("{{source}}").' },
    schema: [],
  },
  create(context) {
    function check(node, source) {
      if (typeof source === 'string' && OPTIMIZER_SEGMENT.test(source))
        context.report({ node, messageId: 'banned', data: { source } });
    }
    return {
      ImportDeclaration: (n) => check(n, n.source.value),
      ExportAllDeclaration: (n) => check(n, n.source.value),
      ExportNamedDeclaration: (n) => n.source && check(n, n.source.value),
      ImportExpression: (n) => n.source.type === 'Literal' && check(n, n.source.value),
      CallExpression(n) {
        if (
          n.callee.type === 'Identifier' &&
          n.callee.name === 'require' &&
          n.arguments[0]?.type === 'Literal'
        )
          check(n, n.arguments[0].value);
      },
    };
  },
};
