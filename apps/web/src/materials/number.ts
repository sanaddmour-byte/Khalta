/** Parses a typed number: Western or Arabic-Indic digits, decimal point or comma. Empty/invalid → null. */
export function parseNumber(text: string): number | null {
  const s = text
    .trim()
    .replace(/[٠-٩]/g, (c) => String(c.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (c) => String(c.charCodeAt(0) - 0x06f0))
    .replace(/[٫,]/g, '.');
  if (s === '' || !/^-?\d*\.?\d+$/.test(s)) return null;
  return Number(s);
}
