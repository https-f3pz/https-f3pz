// Numbers that outlive the float64 range.
//
// An idle game runs out of double precision embarrassingly early: 1e308 arrives
// well before the interesting part of the curve, and everything past it is
// Infinity, which poisons every downstream comparison and formats as "∞"
// forever. So every quantity that can grow without bound is a Big: a mantissa
// and a base-10 exponent, held as two plain numbers.
//
//   value = m * 10^e,  with 1 <= |m| < 10  (or m === 0 exactly)
//
// The representation is deliberately *not* an object graph — a Big is a bare
// {m, e} pair with no methods, and every operation is a free function that
// returns a fresh pair. That keeps it trivially JSON-serialisable for the save
// file and keeps the hot path free of prototype lookups.
//
// Precision is float64's ~15-16 significant digits on the mantissa, which is
// far more than an idle game can show. The exponent is a plain number, so the
// ceiling is ~1e308 orders of magnitude — i.e. 10^(1e308), which no idle curve
// will reach in the lifetime of the universe.

// Below this exponent gap, adding the smaller value cannot change any digit the
// mantissa can represent, so the addition is skipped entirely.
const EPS_GAP = 17;

export const ZERO = { m: 0, e: 0 };
export const ONE = { m: 1, e: 0 };

/** Renormalise so the mantissa sits in [1, 10). */
function norm(m, e) {
  if (!Number.isFinite(m) || m === 0) return { m: 0, e: 0 };
  if (!Number.isFinite(e)) return { m: m < 0 ? -1 : 1, e: Number.MAX_VALUE };
  const sign = m < 0 ? -1 : 1;
  let a = Math.abs(m);
  // A single log10 handles any magnitude in one step; a normalise-by-looping
  // would take 300+ iterations coming back from a big division.
  const shift = Math.floor(Math.log10(a));
  a /= Math.pow(10, shift);
  e += shift;
  // log10/pow round-off can leave the mantissa a hair outside the range.
  if (a >= 10) { a /= 10; e += 1; }
  else if (a < 1) { a *= 10; e -= 1; }
  return { m: sign * a, e };
}

/** Coerce a number, a numeric string, or an existing Big into a Big. */
export function big(v) {
  if (typeof v === 'object' && v !== null) return { m: v.m, e: v.e };
  if (typeof v === 'string') return fromString(v);
  return norm(v, 0);
}

/** Build from mantissa and exponent directly: bigFrom(1.5, 30) === 1.5e30. */
export function bigFrom(m, e) {
  return norm(m, e);
}

export function isZero(a) {
  return a.m === 0;
}

export function neg(a) {
  return { m: -a.m, e: a.e };
}

export function abs(a) {
  return { m: Math.abs(a.m), e: a.e };
}

export function add(a, b) {
  if (a.m === 0) return { m: b.m, e: b.e };
  if (b.m === 0) return { m: a.m, e: a.e };
  // Work in the larger operand's exponent so the mantissa keeps its precision.
  const [hi, lo] = a.e >= b.e ? [a, b] : [b, a];
  const gap = hi.e - lo.e;
  if (gap > EPS_GAP) return { m: hi.m, e: hi.e };
  return norm(hi.m + lo.m / Math.pow(10, gap), hi.e);
}

export function sub(a, b) {
  return add(a, neg(b));
}

export function mul(a, b) {
  if (a.m === 0 || b.m === 0) return { m: 0, e: 0 };
  return norm(a.m * b.m, a.e + b.e);
}

export function div(a, b) {
  if (b.m === 0) return { m: 0, e: 0 }; // 0 rather than NaN: a poisoned save is worse
  if (a.m === 0) return { m: 0, e: 0 };
  return norm(a.m / b.m, a.e - b.e);
}

/** Multiply by a plain float. The common case, and worth not boxing. */
export function mulNum(a, n) {
  if (a.m === 0 || n === 0) return { m: 0, e: 0 };
  return norm(a.m * n, a.e);
}

export function divNum(a, n) {
  if (n === 0 || a.m === 0) return { m: 0, e: 0 };
  return norm(a.m / n, a.e);
}

/** log10 of a positive Big, as a plain number. Zero and negatives give -Infinity. */
export function log10(a) {
  if (a.m <= 0) return -Infinity;
  return a.e + Math.log10(a.m);
}

/** 10^n for a plain number n, including non-integer n. */
export function pow10(n) {
  if (!Number.isFinite(n)) return n > 0 ? { m: 1, e: Number.MAX_VALUE } : { m: 0, e: 0 };
  const e = Math.floor(n);
  return norm(Math.pow(10, n - e), e);
}

/** a^n for a plain number n. Defined for a > 0; a === 0 gives 0. */
export function pow(a, n) {
  if (a.m === 0) return { m: 0, e: 0 };
  if (n === 0) return { m: 1, e: 0 };
  if (a.m < 0) {
    // Only integer powers of a negative are real; idle quantities are never
    // negative, so this is a guard rather than a feature.
    const r = pow(abs(a), n);
    return Number.isInteger(n) && n % 2 !== 0 ? neg(r) : r;
  }
  return pow10(log10(a) * n);
}

export function sqrt(a) {
  return pow(a, 0.5);
}

/** -1, 0 or 1. */
export function cmp(a, b) {
  if (a.m === 0 && b.m === 0) return 0;
  if (a.m === 0) return b.m > 0 ? -1 : 1;
  if (b.m === 0) return a.m > 0 ? 1 : -1;
  const as = a.m < 0 ? -1 : 1;
  const bs = b.m < 0 ? -1 : 1;
  if (as !== bs) return as < bs ? -1 : 1;
  if (a.e !== b.e) return (a.e < b.e ? -1 : 1) * as;
  if (a.m === b.m) return 0;
  return a.m < b.m ? -1 : 1;
}

export const gt = (a, b) => cmp(a, b) > 0;
export const gte = (a, b) => cmp(a, b) >= 0;
export const lt = (a, b) => cmp(a, b) < 0;
export const lte = (a, b) => cmp(a, b) <= 0;
export const eq = (a, b) => cmp(a, b) === 0;
export const max = (a, b) => (cmp(a, b) >= 0 ? a : b);
export const min = (a, b) => (cmp(a, b) <= 0 ? a : b);

/** Clamped conversion to a float, for feeding the renderer. Saturates, never Infinity. */
export function toNumber(a) {
  if (a.m === 0) return 0;
  if (a.e > 308) return a.m < 0 ? -Number.MAX_VALUE : Number.MAX_VALUE;
  if (a.e < -308) return 0;
  return a.m * Math.pow(10, a.e);
}

// ---------------------------------------------------------------- geometry
//
// The single most important operation in an idle game, and the one most often
// got wrong. Buying n units whose cost starts at c0 and multiplies by r each
// time costs the geometric sum c0 * (r^n - 1) / (r - 1). "How many can I
// afford" is that solved for n:
//
//   n = log_r( 1 + budget * (r - 1) / c0 )
//
// Doing it by looping is O(n) and dies the moment n is 1e9; doing it in logs is
// O(1) at any scale.

/** Cost of the `k`th unit (0-indexed) given a base cost and growth ratio. */
export function costOf(base, ratio, k) {
  return mul(base, pow10(Math.log10(ratio) * k));
}

/** Total cost of buying `n` units starting from the `k`th. */
export function costRange(base, ratio, k, n) {
  if (n <= 0) return { m: 0, e: 0 };
  const first = costOf(base, ratio, k);
  if (ratio === 1) return mulNum(first, n);
  // first * (r^n - 1) / (r - 1)
  const num = sub(pow10(Math.log10(ratio) * n), ONE);
  return div(mul(first, num), big(ratio - 1));
}

/**
 * The largest n such that costRange(base, ratio, owned, n) <= budget.
 * Closed form, so it is the same cost whether the answer is 3 or 3 billion.
 */
export function affordable(base, ratio, owned, budget) {
  if (ratio <= 1) {
    const c = costOf(base, ratio, owned);
    if (c.m === 0) return 0;
    return Math.max(0, Math.floor(toNumber(div(budget, c))));
  }
  const first = costOf(base, ratio, owned);
  if (lt(budget, first)) return 0;
  // n = log_r(1 + budget * (r - 1) / first)
  const inner = add(ONE, div(mulNum(budget, ratio - 1), first));
  const n = Math.floor(log10(inner) / Math.log10(ratio));
  if (!Number.isFinite(n)) return 0;
  // The logs are approximate at the boundary; step back onto the exact answer.
  let k = Math.max(0, n);
  while (k > 0 && gt(costRange(base, ratio, owned, k), budget)) k--;
  while (lte(costRange(base, ratio, owned, k + 1), budget)) k++;
  return k;
}

// ------------------------------------------------------------- formatting

const SUFFIX = [
  '', 'K', 'M', 'B', 'T', 'Qa', 'Qi', 'Sx', 'Sp', 'Oc', 'No',
  'Dc', 'UDc', 'DDc', 'TDc', 'QaDc', 'QiDc', 'SxDc', 'SpDc', 'OcDc', 'NoDc',
  'Vg', 'UVg', 'DVg', 'TVg', 'QaVg', 'QiVg', 'SxVg', 'SpVg', 'OcVg', 'NoVg',
  'Tg',
];

/**
 * Human-readable. Small numbers read plainly, the mid range gets a named
 * suffix, and past the names it falls back to scientific — because "1.23e105"
 * is honest and a made-up Latin suffix nobody knows is not.
 */
export function fmt(a, places = 2) {
  const v = big(a);
  if (v.m === 0) return '0';
  if (v.m < 0) return `-${fmt(neg(v), places)}`;

  if (v.e < -4) return `${v.m.toFixed(places)}e${v.e}`;
  if (v.e < 0) return toNumber(v).toFixed(Math.min(6, places + 2));

  // Under a thousand: no suffix, and no decimals once it reads as a count.
  if (v.e < 3) {
    const n = toNumber(v);
    return n < 10 && !Number.isInteger(n) ? n.toFixed(places) : Math.floor(n).toLocaleString();
  }

  const group = Math.floor(v.e / 3);
  if (group < SUFFIX.length) {
    const mant = v.m * Math.pow(10, v.e - group * 3);
    return `${mant.toFixed(places)}${SUFFIX[group]}`;
  }
  return `${v.m.toFixed(places)}e${v.e}`;
}

/** Compact form for tight UI: never more than 6 glyphs where it can be helped. */
export function fmtShort(a) {
  const v = big(a);
  if (v.m === 0) return '0';
  if (v.e < 3) return String(Math.floor(toNumber(v)));
  const group = Math.floor(v.e / 3);
  if (group < SUFFIX.length) {
    const mant = v.m * Math.pow(10, v.e - group * 3);
    return `${mant < 10 ? mant.toFixed(1) : Math.floor(mant)}${SUFFIX[group]}`;
  }
  return `e${Math.floor(v.e)}`;
}

// ------------------------------------------------------------ persistence

/** Compact, lossless-enough string for the save file. */
export function toString(a) {
  if (a.m === 0) return '0';
  if (a.e === 0) return String(a.m);
  return `${a.m}e${a.e}`;
}

export function fromString(s) {
  if (typeof s !== 'string') return big(s ?? 0);
  const t = s.trim();
  if (!t || t === '0') return { m: 0, e: 0 };
  const i = t.indexOf('e');
  if (i < 0) return norm(Number(t), 0);
  const m = Number(t.slice(0, i));
  const e = Number(t.slice(i + 1));
  if (!Number.isFinite(m) || !Number.isFinite(e)) return { m: 0, e: 0 };
  return norm(m, e);
}
