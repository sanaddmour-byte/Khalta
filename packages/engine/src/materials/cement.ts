// Cement classification (M7.1, ADR 0018): the market type (OPC, PPC, SRC, low alkali, white) and the strength class
// (32.5, 42.5, 52.5). These are LABELS. They are shown, filtered on and checked for consistency with the mill
// certificate, and they define a strength model's group; no compliance check ever reads them.
import { CEMENT_CLASSES, CEMENT_KINDS, type CementClass, type CementKind } from './properties';

export const CEMENT_KIND_ORDER = CEMENT_KINDS;
export const KIND_LABEL: Record<CementKind, string> = {
  opc: 'OPC',
  ppc: 'PPC',
  src: 'SRC',
  low_alkali: 'Low alkali',
  white: 'White',
};

/** What the market name usually corresponds to in EN 197-1 / ASTM terms (display and import hints only; never a rule). */
export const MARKET_EQUIVALENT: Record<CementKind, string> = {
  opc: 'CEM I / ASTM Type I',
  ppc: 'CEM II/x-P (Portland-pozzolana)',
  src: 'CEM I-SR / ASTM Type V',
  low_alkali: 'low-alkali Portland (Na2O-eq within the QC limit)',
  white: 'white Portland cement (a white CEM I)',
};

export interface CementLabel {
  kind: CementKind | null;
  strengthClass: CementClass | null;
}

export function cementLabel(props: Record<string, unknown> | null | undefined): CementLabel {
  const k = props?.['cement_kind'];
  const c = props?.['cement_strength_class'];
  return {
    kind: (CEMENT_KINDS as readonly unknown[]).includes(k) ? (k as CementKind) : null,
    strengthClass: (CEMENT_CLASSES as readonly unknown[]).includes(c) ? (c as CementClass) : null,
  };
}

/** "OPC 42.5", "White 52.5", "SRC", "42.5" or null. */
export function cementLabelText(l: CementLabel): string | null {
  const t = [
    l.kind ? KIND_LABEL[l.kind] : null,
    l.strengthClass !== null ? String(l.strengthClass) : null,
  ]
    .filter(Boolean)
    .join(' ');
  return t || null;
}

/**
 * A suggestion parsed from a market name such as "OPC 42.5N", "SRC 32.5", "white cement 52.5" or "PPC 42.5R".
 * Only a suggestion: a person confirms it; nothing is filled silently. Arabic names are recognised too.
 */
export function suggestCementLabel(name: string): CementLabel {
  const n = name.toLowerCase();
  let kind: CementKind | null = null;
  if (/white|أبيض|ابيض/.test(n)) kind = 'white';
  else if (/low[\s-]*alkali|قليل\s*القلويات|منخفض\s*القلويات/.test(n)) kind = 'low_alkali';
  else if (/\bsrc\b|sulfate[\s-]*resist|sr[035]\b|مقاوم\s*للكبريتات/.test(n)) kind = 'src';
  else if (/\bppc\b|pozzol|بوزولان|\bcem\s*ii\/[ab]-p\b|cem\s*iv/.test(n)) kind = 'ppc';
  else if (/\bopc\b|ordinary\s*portland|بورتلاندي\s*عادي|\bcem\s*i\b/.test(n)) kind = 'opc';
  const m = /(?:^|[^\d.])(32\.5|42\.5|52\.5)(?!\d)/.exec(name.replace(/٫/g, '.'));
  return { kind, strengthClass: m ? (Number(m[1]) as CementClass) : null };
}

export type CementColour = 'any' | 'white' | 'grey';
/**
 * Whether a cement may be used under a colour request. "white only" needs a cement recorded as white (an unlabelled
 * cement is not assumed white); "grey only" excludes white cements (an unlabelled one stays, it is not known to be white).
 */
export function colourAllows(colour: CementColour, kind: CementKind | null): boolean {
  if (colour === 'any') return true;
  return colour === 'white' ? kind === 'white' : kind !== 'white';
}

/** The strength model's cement "kind" string: kind, class and the certificate wording, so a change of any is a new group. */
export function cementGroupKind(props: Record<string, unknown> | null | undefined): string | null {
  const l = cementLabel(props);
  const type = props?.['cement_type'];
  const parts = [
    l.kind,
    l.strengthClass !== null ? String(l.strengthClass) : null,
    typeof type === 'string' && type ? type : null,
  ].filter(Boolean);
  return parts.length ? parts.join('|') : null;
}
