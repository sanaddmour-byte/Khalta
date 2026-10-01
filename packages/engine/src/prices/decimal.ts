// Exact decimal arithmetic for money and per-kg prices. Values are strings at the edges and scaled
// bigints inside; floats never touch a price. Internal scale is 9 decimal places.
const SCALE = 9;
const ONE = 10n ** BigInt(SCALE);

const PLAIN = /^\d{1,12}(\.\d{1,9})?$/;

/** Parses a plain decimal string ("12", "0.0125") into a scaled bigint, or null. */
export function parseDecimal(s: string): bigint | null {
  if (!PLAIN.test(s)) return null;
  const [int, frac = ''] = s.split('.');
  return BigInt(int!) * ONE + BigInt(frac.padEnd(SCALE, '0'));
}

/** Fixed 9-decimal string, e.g. 12500000n → "0.012500000". */
export function formatDecimal(v: bigint, places = SCALE): string {
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const whole = abs / ONE;
  const frac = (abs % ONE).toString().padStart(SCALE, '0').slice(0, places);
  return `${neg ? '-' : ''}${whole}${places > 0 ? `.${frac}` : ''}`;
}

/** a ÷ b, rounded half up to 9 places. b must be positive. */
export function divide(a: bigint, b: bigint): bigint {
  if (b <= 0n) throw new RangeError('divisor must be positive');
  return (a * ONE * 2n + b) / (b * 2n);
}

/** a × b, rounded half up to 9 places. */
export function multiply(a: bigint, b: bigint): bigint {
  return (a * b * 2n + ONE) / (ONE * 2n);
}

/** Rounds a scaled value half up to `places` decimals and returns it as a string. */
export function roundTo(v: bigint, places: number): string {
  const unit = 10n ** BigInt(SCALE - places);
  const rounded = ((v + unit / 2n) / unit) * unit;
  return formatDecimal(rounded, places);
}
