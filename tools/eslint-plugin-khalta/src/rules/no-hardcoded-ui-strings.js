// Flags literal user-facing text in JSX: element text and a fixed set of text-bearing attributes.
const TEXT_ATTRIBUTES = new Set(['title', 'aria-label', 'placeholder', 'alt', 'aria-description']);
// Text with no letters (numbers, punctuation, symbols) is not translatable copy.
const HAS_LETTER = /\p{L}/u;

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'problem',
    messages: {
      text: 'Hard-coded UI text "{{text}}": use an i18n key.',
      attr: 'Hard-coded "{{name}}" attribute text "{{text}}": use an i18n key.',
    },
    schema: [],
  },
  create(context) {
    return {
      JSXText(node) {
        const text = node.value.trim();
        if (text && HAS_LETTER.test(text))
          context.report({ node, messageId: 'text', data: { text } });
      },
      JSXAttribute(node) {
        if (node.name.type !== 'JSXIdentifier' || !TEXT_ATTRIBUTES.has(node.name.name)) return;
        const v = node.value;
        let text;
        if (v?.type === 'Literal' && typeof v.value === 'string') text = v.value;
        else if (
          v?.type === 'JSXExpressionContainer' &&
          v.expression.type === 'Literal' &&
          typeof v.expression.value === 'string'
        )
          text = v.expression.value;
        else if (
          v?.type === 'JSXExpressionContainer' &&
          v.expression.type === 'TemplateLiteral' &&
          v.expression.expressions.length === 0
        )
          text = v.expression.quasis.map((q) => q.value.cooked).join('');
        if (text && HAS_LETTER.test(text))
          context.report({ node, messageId: 'attr', data: { name: node.name.name, text } });
      },
      // {'literal'} children
      JSXExpressionContainer(node) {
        if (node.parent.type !== 'JSXElement' && node.parent.type !== 'JSXFragment') return;
        const e = node.expression;
        const text =
          e.type === 'Literal' && typeof e.value === 'string'
            ? e.value
            : e.type === 'TemplateLiteral' && e.expressions.length === 0
              ? e.quasis.map((q) => q.value.cooked).join('')
              : undefined;
        if (text && HAS_LETTER.test(text))
          context.report({ node, messageId: 'text', data: { text } });
      },
    };
  },
};
