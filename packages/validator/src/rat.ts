// Exact rational arithmetic for the validator. The evaluator computes with floating point; this module
// shares nothing with it, so a rounding or formula slip in one is not repeated in the other.

const gcd = (a: bigint, b: bigint): bigint => {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) [x, y] = [y, x % y];
  return x;
};

export class Rat {
  readonly n: bigint;
  readonly d: bigint;
  constructor(n: bigint, d: bigint = 1n) {
    if (d === 0n) throw new RangeError('division by zero');
    const g = gcd(n, d) || 1n;
    const s = d < 0n ? -1n : 1n;
    this.n = (s * n) / g;
    this.d = (s * d) / g;
  }
  static of(x: number | string | bigint): Rat {
    if (typeof x === 'bigint') return new Rat(x);
    const text = typeof x === 'number' ? x.toString() : x.trim();
    const m = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(text);
    if (!m) throw new RangeError(`not a decimal: ${text}`);
    const frac = m[3] ?? '';
    let n = BigInt(`${m[2]}${frac}`);
    const exp = (m[4] ? Number(m[4]) : 0) - frac.length;
    if (m[1]) n = -n;
    let d = 1n;
    if (exp >= 0) n *= 10n ** BigInt(exp);
    else d = 10n ** BigInt(-exp);
    return new Rat(n, d);
  }
  add(o: Rat) {
    return new Rat(this.n * o.d + o.n * this.d, this.d * o.d);
  }
  sub(o: Rat) {
    return new Rat(this.n * o.d - o.n * this.d, this.d * o.d);
  }
  mul(o: Rat) {
    return new Rat(this.n * o.n, this.d * o.d);
  }
  div(o: Rat) {
    return new Rat(this.n * o.d, this.d * o.n);
  }
  neg() {
    return new Rat(-this.n, this.d);
  }
  cmp(o: Rat): -1 | 0 | 1 {
    const l = this.n * o.d;
    const r = o.n * this.d;
    return l < r ? -1 : l > r ? 1 : 0;
  }
  lte(o: Rat) {
    return this.cmp(o) <= 0;
  }
  gte(o: Rat) {
    return this.cmp(o) >= 0;
  }
  gt(o: Rat) {
    return this.cmp(o) > 0;
  }
  isZero() {
    return this.n === 0n;
  }
  abs() {
    return this.n < 0n ? this.neg() : this;
  }
  /** Nearest double (via 15 digits of scaled integer division; ample for tolerance comparisons). */
  toNumber(): number {
    const scale = 10n ** 15n;
    return Number((this.n * scale) / this.d) / 1e15;
  }
  /** Round half away from zero to `places` decimals, as a fixed-point string. */
  toFixed(places: number): string {
    const scale = 10n ** BigInt(places);
    const neg = this.n < 0n;
    const a = neg ? -this.n : this.n;
    const q = (a * scale * 2n + this.d) / (this.d * 2n);
    const s = q.toString().padStart(places + 1, '0');
    const whole = s.slice(0, s.length - places);
    const frac = s.slice(s.length - places);
    return `${neg && q !== 0n ? '-' : ''}${whole}${places > 0 ? `.${frac}` : ''}`;
  }
}

export const R = Rat.of;
export const ZERO = new Rat(0n);
export const ONE = new Rat(1n);
export const sum = (xs: Rat[]) => xs.reduce((a, b) => a.add(b), ZERO);
