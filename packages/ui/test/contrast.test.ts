import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(join(import.meta.dirname, '../src/tokens.css'), 'utf8');

function block(selector: RegExp): Record<string, string> {
  const m = css.match(selector);
  if (!m?.[1]) throw new Error(`block not found: ${selector}`);
  const out: Record<string, string> = {};
  for (const [, k, v] of m[1].matchAll(/--([a-z0-9-]+):\s*(#[0-9a-f]{6});/gi)) out[k!] = v!;
  return out;
}
const light = block(/:root\s*\{([^}]*)\}/);
const dark = { ...light, ...block(/:root\[data-theme='dark'\]\s*\{([^}]*)\}/) };

function lum(hex: string) {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const [r, g, b] = c.map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)) as [
    number,
    number,
    number,
  ];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
export function contrast(a: string, b: string) {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

// Text pairs: every one must be >= 4.5:1 (03-ui.md §5). Status/olive TEXT uses the *-text tokens.
const PAIRS: [string, string, string][] = [
  ['grey-900', 'grey-50', 'body on app'],
  ['grey-900', 'grey-100', 'body on surface'],
  ['grey-800', 'grey-50', 'heading on app'],
  ['grey-800', 'grey-100', 'heading on surface'],
  ['grey-500', 'grey-50', 'muted on app'],
  ['grey-500', 'grey-100', 'muted on surface'],
  ['green-dark-700', 'grey-50', 'primary link on app'],
  ['green-dark-700', 'grey-100', 'primary link on surface'],
  ['green-dark-700', 'green-dark-50', 'primary on selected row'],
  ['on-primary', 'green-dark-700', 'primary button / JS badge'],
  ['on-primary', 'green-dark-800', 'primary button hover'],
  ['on-olive', 'olive-600', 'PROJECT badge'],
  ['olive-text', 'olive-100', 'olive text on tint'],
  ['olive-text', 'grey-100', 'olive text on surface'],
  ['pass-text', 'pass-bg', 'pass chip'],
  ['fail-text', 'fail-bg', 'fail chip'],
  ['warn-text', 'warn-bg', 'warn chip'],
  ['pass-text', 'grey-100', 'saving text on surface'],
  ['fail-text', 'grey-100', 'increase text on surface'],
  ['warn-text', 'grey-100', 'warning text on surface'],
  ['pass-text', 'grey-50', 'saving text on app'],
  ['fail-text', 'grey-50', 'increase text on app'],
  ['warn-text', 'grey-50', 'warning text on app'],
  ['grey-800', 'grey-100', 'ACI outline badge'],
  ['grey-900', 'pass-bg', 'body on pass tint'],
  ['grey-900', 'fail-bg', 'body on fail tint'],
  ['grey-900', 'warn-bg', 'body on warn tint'],
  ['grey-900', 'olive-100', 'body on olive tint'],
  ['grey-900', 'green-dark-50', 'body on primary tint'],
];

// Non-text (icons, borders, focus ring): WCAG 1.4.11 asks for >= 3:1.
const GRAPHIC: [string, string, string][] = [
  ['pass', 'pass-bg', 'pass icon on tint'],
  ['fail', 'fail-bg', 'fail icon on tint'],
  ['warn', 'warn-bg', 'warn icon on tint'],
  ['pass', 'grey-100', 'pass icon on surface'],
  ['fail', 'grey-100', 'fail icon on surface'],
  ['warn', 'grey-100', 'warn icon on surface'],
  ['focus-ring', 'grey-50', 'focus ring on app'],
  ['focus-ring', 'grey-100', 'focus ring on surface'],
];

describe.each([
  ['light', light],
  ['dark', dark],
])('%s theme contrast', (_name, tokens) => {
  it.each(PAIRS)('%s on %s (%s) >= 4.5:1', (fg, bg) => {
    expect(tokens[fg], fg).toBeDefined();
    expect(tokens[bg], bg).toBeDefined();
    expect(contrast(tokens[fg]!, tokens[bg]!)).toBeGreaterThanOrEqual(4.5);
  });
});

describe.each([
  ['light', light],
  ['dark', dark],
])('%s theme graphics contrast', (_name, tokens) => {
  it.each(GRAPHIC)('%s on %s (%s) >= 3:1', (fg, bg) => {
    expect(contrast(tokens[fg]!, tokens[bg]!)).toBeGreaterThanOrEqual(3);
  });
});

it('every light token has a dark counterpart where the spec defines one', () => {
  const spec = [
    'grey-50',
    'grey-100',
    'grey-200',
    'grey-500',
    'grey-800',
    'grey-900',
    'green-dark-700',
    'green-dark-800',
    'green-dark-50',
    'olive-600',
    'olive-100',
    'pass',
    'pass-bg',
    'fail',
    'fail-bg',
    'warn',
    'warn-bg',
  ];
  const darkOnly = block(/:root\[data-theme='dark'\]\s*\{([^}]*)\}/);
  for (const t of spec) expect(darkOnly[t], t).toBeDefined();
});
