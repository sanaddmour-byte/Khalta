import { divide, formatDecimal, parseDecimal } from './decimal';

export const PRICE_UNITS = ['JOD/ton', 'JOD/m3', 'JOD/kg', 'JOD/L'] as const;
export type PriceUnit = (typeof PRICE_UNITS)[number];

export type ConvertResult =
  | { ok: true; jodPerKg: string }
  | { ok: false; reason: 'invalid_price' | 'needs_density' | 'needs_sg'; missing?: string };

/** Max price precision stored in the database (`numeric(12,3)`). */
export const PRICE_PATTERN = /^\d{1,9}(\.\d{1,3})?$/;

/**
 * Converts a price to JOD per kg. Nothing is guessed: `JOD/m3` needs a bulk density we do not hold, and
 * `JOD/L` needs the material's specific gravity (kg per litre); without them the result says what is missing.
 */
export function toJodPerKg(input: {
  price: string;
  unit: PriceUnit;
  sg?: number | string | null;
}): ConvertResult {
  const p = parseDecimal(input.price);
  if (p === null || !PRICE_PATTERN.test(input.price)) return { ok: false, reason: 'invalid_price' };
  switch (input.unit) {
    case 'JOD/kg':
      return { ok: true, jodPerKg: formatDecimal(p) };
    case 'JOD/ton':
      return { ok: true, jodPerKg: formatDecimal(divide(p, 1000n * 10n ** 9n)) };
    case 'JOD/L': {
      const raw = input.sg;
      const sg =
        raw === null || raw === undefined
          ? null
          : parseDecimal(typeof raw === 'number' ? raw.toFixed(6) : raw);
      if (sg === null || sg <= 0n) return { ok: false, reason: 'needs_sg', missing: 'sg' };
      return { ok: true, jodPerKg: formatDecimal(divide(p, sg)) };
    }
    case 'JOD/m3':
      return { ok: false, reason: 'needs_density', missing: 'density' };
  }
}
