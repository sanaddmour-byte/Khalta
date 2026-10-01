/** Order-independent JSON text: PostgreSQL jsonb does not preserve object key order. */
export function canonical(value: unknown): string {
  const norm = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(norm);
    if (v !== null && typeof v === 'object')
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([k, x]) => [k, norm(x)]),
      );
    return v ?? null;
  };
  return JSON.stringify(norm(value));
}
export const sameJson = (a: unknown, b: unknown) => canonical(a) === canonical(b);
