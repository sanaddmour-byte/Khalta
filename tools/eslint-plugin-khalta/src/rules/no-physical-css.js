// Flags physical-direction CSS (left/right) in class strings and inline styles. Use logical
// utilities (ms-*, pe-*, start-*, text-start, rounded-s, border-e, ...).
const CLASS_CALLEES = new Set(['cn', 'clsx', 'cx', 'cva', 'twMerge', 'classNames']);

const PHYSICAL_TOKEN = [
  /^-?[mp][lr]-/, // ml-2, pr-4, -mr-1
  /^-?(left|right)-/, // left-0, -right-2
  /^text-(left|right)$/,
  /^(float|clear)-(left|right)$/,
  /^rounded-([lr]|[tb][lr])(-|$)/, // rounded-l, rounded-tr-lg
  /^border-[lr](-|$)/,
  /^scroll-[mp][lr]-/,
  /^space-x-reverse$/,
];

const PHYSICAL_STYLE_PROPS = new Set([
  'left',
  'right',
  'marginLeft',
  'marginRight',
  'paddingLeft',
  'paddingRight',
  'borderLeft',
  'borderRight',
  'borderLeftWidth',
  'borderRightWidth',
  'borderTopLeftRadius',
  'borderTopRightRadius',
  'borderBottomLeftRadius',
  'borderBottomRightRadius',
  'textAlign:left',
  'textAlign:right',
  'float:left',
  'float:right',
]);

export function physicalTokens(classString) {
  return classString
    .split(/\s+/)
    .filter(Boolean)
    .filter((raw) => {
      const base = raw.slice(raw.lastIndexOf(':') + 1).replace(/^!/, '');
      return PHYSICAL_TOKEN.some((re) => re.test(base));
    });
}

function isClassAttr(node) {
  return node && node.type === 'JSXAttribute' && ['className', 'class'].includes(node.name.name);
}

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'problem',
    messages: {
      cls: 'Physical CSS class "{{token}}": use the logical equivalent (start/end).',
      style: 'Physical inline style "{{prop}}": use the logical property (inline-start/end).',
    },
    schema: [],
  },
  create(context) {
    function checkString(node, value) {
      for (const token of physicalTokens(value))
        context.report({ node, messageId: 'cls', data: { token } });
    }

    function inClassContext(node) {
      for (let n = node.parent; n; n = n.parent) {
        if (isClassAttr(n)) return true;
        if (
          n.type === 'CallExpression' &&
          n.callee.type === 'Identifier' &&
          CLASS_CALLEES.has(n.callee.name)
        )
          return true;
        if (n.type === 'JSXElement' || n.type === 'Program') return false;
      }
      return false;
    }

    return {
      Literal(node) {
        if (typeof node.value === 'string' && inClassContext(node)) checkString(node, node.value);
      },
      TemplateElement(node) {
        if (inClassContext(node)) checkString(node, node.value.cooked ?? '');
      },
      JSXAttribute(node) {
        if (node.name.name !== 'style' || node.value?.type !== 'JSXExpressionContainer') return;
        const obj = node.value.expression;
        if (obj.type !== 'ObjectExpression') return;
        for (const p of obj.properties) {
          if (p.type !== 'Property') continue;
          const key = p.key.type === 'Identifier' ? p.key.name : p.key.value;
          const val = p.value.type === 'Literal' ? p.value.value : undefined;
          if (PHYSICAL_STYLE_PROPS.has(key) || PHYSICAL_STYLE_PROPS.has(`${key}:${val}`))
            context.report({ node: p, messageId: 'style', data: { prop: key } });
        }
      },
    };
  },
};
