// Correctness checks for the numeric core: src/core/big.js and src/core/awaytime.js.
//
//   node tools/coretest.mjs
//
// Big is load-bearing for every number in the game, and a silent precision bug
// in it looks like a balance problem thirty hours later. Where a result fits in
// float64 the answer is checked against plain arithmetic; past that, against
// identities that must hold at any scale.

import * as B from '../src/core/big.js';

let pass = 0;
let fail = 0;
const results = [];

function ok(name, cond, detail = '') {
  if (cond) { pass++; results.push(`  \x1b[32mPASS\x1b[0m  ${name}`); }
  else { fail++; results.push(`  \x1b[31mFAIL\x1b[0m  ${name}  \x1b[2m${detail}\x1b[0m`); }
}

/** Relative closeness, so the check is scale-free. */
function close(a, b, tol = 1e-9) {
  const la = B.log10(B.abs(a));
  const lb = B.log10(B.abs(b));
  if (!Number.isFinite(la) && !Number.isFinite(lb)) return true;
  if (B.isZero(a) && B.isZero(b)) return true;
  if (B.isZero(a) || B.isZero(b)) return false;
  return Math.abs(la - lb) < tol;
}

// ------------------------------------------------------- against float64
const FLOATS = [0, 1, 2, 7, 10, 999, 1000, 1e6, 1.5e9, 6.02e23, 1e-7, 3.33, 12345.678];

for (const x of FLOATS) {
  for (const y of FLOATS) {
    const a = B.big(x);
    const b = B.big(y);
    if (x + y !== 0 && Math.abs(x + y) > 1e-12) {
      ok(`add ${x}+${y}`, close(B.add(a, b), B.big(x + y), 1e-9), `${B.fmt(B.add(a, b))} vs ${x + y}`);
    }
    if (x * y !== 0) {
      ok(`mul ${x}*${y}`, close(B.mul(a, b), B.big(x * y), 1e-9), `${B.fmt(B.mul(a, b))} vs ${x * y}`);
    }
    if (y !== 0 && x !== 0) {
      ok(`div ${x}/${y}`, close(B.div(a, b), B.big(x / y), 1e-9), `${B.fmt(B.div(a, b))} vs ${x / y}`);
    }
    ok(`cmp ${x}?${y}`, B.cmp(a, b) === Math.sign(x - y), `got ${B.cmp(a, b)} want ${Math.sign(x - y)}`);
  }
}

// --------------------------------------------------- beyond the float range
// The whole reason Big exists: these are all Infinity in float64.
const HUGE = B.bigFrom(1, 400);
const HUGER = B.bigFrom(1, 800);

ok('1e400 is representable', B.log10(HUGE) === 400, `log10=${B.log10(HUGE)}`);
ok('1e400 * 1e400 = 1e800', close(B.mul(HUGE, HUGE), HUGER), B.fmt(B.mul(HUGE, HUGE)));
ok('1e800 / 1e400 = 1e400', close(B.div(HUGER, HUGE), HUGE), B.fmt(B.div(HUGER, HUGE)));
ok('1e400 > 1e399', B.gt(HUGE, B.bigFrom(1, 399)));
ok('(1e400)^3 = 1e1200', Math.abs(B.log10(B.pow(HUGE, 3)) - 1200) < 1e-6, `${B.log10(B.pow(HUGE, 3))}`);
ok('sqrt(1e400) = 1e200', Math.abs(B.log10(B.sqrt(HUGE)) - 200) < 1e-6);
ok('no Infinity leaks from toNumber', Number.isFinite(B.toNumber(HUGER)));
ok('toNumber saturates rather than overflowing', B.toNumber(HUGER) === Number.MAX_VALUE);

// Absurd scale — an idle game with several prestige layers really does get here.
const ABSURD = B.bigFrom(3.7, 1e6);
ok('1e1000000 survives', Math.abs(B.log10(ABSURD) - (1e6 + Math.log10(3.7))) < 1e-6);
ok('absurd multiplication stays exact in logs',
  Math.abs(B.log10(B.mul(ABSURD, ABSURD)) - 2 * B.log10(ABSURD)) < 1e-6);

// ------------------------------------------------------------- identities
const SAMPLES = [B.big(1), B.big(7.5), B.bigFrom(1, 20), B.bigFrom(9.99, 137), B.bigFrom(2, 5000)];
for (const a of SAMPLES) {
  for (const b of SAMPLES) {
    ok(`(a*b)/b = a  [${B.fmt(a)} , ${B.fmt(b)}]`, close(B.div(B.mul(a, b), b), a, 1e-9));
    ok(`a+b = b+a  [${B.fmt(a)} , ${B.fmt(b)}]`, B.cmp(B.add(a, b), B.add(b, a)) === 0);
    ok(`a+b >= max(a,b)  [${B.fmt(a)} , ${B.fmt(b)}]`, B.gte(B.add(a, b), B.max(a, b)));
  }
  ok(`a - a = 0  [${B.fmt(a)}]`, B.isZero(B.sub(a, a)), B.fmt(B.sub(a, a)));
  ok(`a * 0 = 0  [${B.fmt(a)}]`, B.isZero(B.mul(a, B.ZERO)));
  ok(`a * 1 = a  [${B.fmt(a)}]`, B.cmp(B.mul(a, B.ONE), a) === 0);
  ok(`a^0 = 1  [${B.fmt(a)}]`, B.cmp(B.pow(a, 0), B.ONE) === 0);
  ok(`a^1 = a  [${B.fmt(a)}]`, close(B.pow(a, 1), a));
}

// A tiny addend must not corrupt a huge accumulator, and must not be lost when
// it is not tiny — both directions of the epsilon-gap shortcut.
ok('1e100 + 1 = 1e100', B.cmp(B.add(B.bigFrom(1, 100), B.ONE), B.bigFrom(1, 100)) === 0);
ok('1e10 + 1 != 1e10', B.cmp(B.add(B.bigFrom(1, 10), B.ONE), B.bigFrom(1, 10)) !== 0);
ok('1e16 + 1e16 = 2e16', close(B.add(B.bigFrom(1, 16), B.bigFrom(1, 16)), B.bigFrom(2, 16)));

// Degenerate inputs must produce a usable number, never NaN — a NaN written to
// the save file bricks the game permanently.
ok('div by zero gives 0, not NaN', B.isZero(B.div(B.ONE, B.ZERO)));
ok('log10(0) is -Infinity, not NaN', B.log10(B.ZERO) === -Infinity);
ok('big(NaN) is 0', B.isZero(B.big(NaN)));
ok('big(Infinity) does not produce NaN mantissa', Number.isFinite(B.big(Infinity).m));
ok('0 formats as "0"', B.fmt(B.ZERO) === '0');

// ------------------------------------------------- the geometric machinery
// Closed-form "how many can I afford" against a brute-force loop, in the range
// where brute force is actually tractable.
function bruteAffordable(base, ratio, owned, budget) {
  let n = 0;
  let spent = B.ZERO;
  for (let i = 0; i < 100000; i++) {
    const next = B.add(spent, B.costOf(B.big(base), ratio, owned + i));
    if (B.gt(next, budget)) break;
    spent = next;
    n++;
  }
  return n;
}

for (const ratio of [1.07, 1.15, 1.5, 2, 3.3]) {
  for (const owned of [0, 1, 17, 250]) {
    for (const budgetE of [1, 4, 9, 22]) {
      const budget = B.bigFrom(1, budgetE);
      const want = bruteAffordable(10, ratio, owned, budget);
      const got = B.affordable(B.big(10), ratio, owned, budget);
      ok(`affordable r=${ratio} owned=${owned} budget=1e${budgetE}`, got === want, `got ${got} want ${want}`);
    }
  }
}

// And that it stays exact where brute force cannot go at all.
{
  const budget = B.bigFrom(1, 500);
  const n = B.affordable(B.big(10), 1.15, 0, budget);
  ok('affordable at 1e500 returns a finite count', Number.isFinite(n) && n > 0, `n=${n}`);
  ok('affordable at 1e500 is exactly on the boundary',
    B.lte(B.costRange(B.big(10), 1.15, 0, n), budget) &&
    B.gt(B.costRange(B.big(10), 1.15, 0, n + 1), budget), `n=${n}`);
}

// costRange must agree with summing costOf term by term.
{
  let sum = B.ZERO;
  for (let i = 0; i < 40; i++) sum = B.add(sum, B.costOf(B.big(25), 1.12, 3 + i));
  ok('costRange = sum of costOf', close(B.costRange(B.big(25), 1.12, 3, 40), sum, 1e-9),
    `${B.fmt(B.costRange(B.big(25), 1.12, 3, 40))} vs ${B.fmt(sum)}`);
}
ok('costRange(0) is zero', B.isZero(B.costRange(B.big(10), 1.5, 0, 0)));

// ------------------------------------------------------------- formatting
const FMT = [
  [B.big(0), '0'],
  [B.big(7), '7'],
  [B.big(999), '999'],
  [B.big(1500), '1.50K'],
  [B.big(1.5e6), '1.50M'],
  [B.big(1.5e9), '1.50B'],
  [B.bigFrom(1.5, 12), '1.50T'],
  [B.bigFrom(2.25, 15), '2.25Qa'],
];
for (const [v, want] of FMT) {
  ok(`fmt(${B.toString(v)}) = ${want}`, B.fmt(v) === want, `got "${B.fmt(v)}"`);
}
ok('fmt falls back to scientific past the suffix table', /e\d+/.test(B.fmt(B.bigFrom(1.5, 400))), B.fmt(B.bigFrom(1.5, 400)));
ok('fmt never returns undefined/NaN text', FMT.every(([v]) => !/NaN|undefined/.test(B.fmt(v))));
ok('fmtShort stays short', B.fmtShort(B.bigFrom(1.5, 400)).length <= 8, B.fmtShort(B.bigFrom(1.5, 400)));

// -------------------------------------------------------------- round trip
for (const v of [B.ZERO, B.big(1), B.big(1234.5), B.bigFrom(9.87, 321), B.bigFrom(1.1, -40), B.bigFrom(4, 1e6)]) {
  const s = B.toString(v);
  ok(`round trip ${s}`, close(B.fromString(s), v, 1e-12) || (B.isZero(v) && B.isZero(B.fromString(s))));
  ok(`round trip survives JSON ${s}`, close(B.fromString(JSON.parse(JSON.stringify(s))), v, 1e-12) || B.isZero(v));
}
ok('fromString rejects junk without NaN', B.isZero(B.fromString('nonsense')) || Number.isFinite(B.fromString('nonsense').m));
ok('fromString handles empty', B.isZero(B.fromString('')));

// ------------------------------------------------------------- away clock
import { resolveAway, humanDuration, AWAY_CAP } from '../src/core/awaytime.js';

const T0 = 1_700_000_000_000; // a fixed "now" so these are not wall-clock dependent

{
  const r = resolveAway({ wall: T0 - 3600_000 }, { now: T0 });
  ok('one hour away credits one hour', Math.abs(r.seconds - 3600) < 1, JSON.stringify(r));
  ok('one hour away is not capped', !r.capped);
  ok('one hour away is not backwards', !r.backwards);
}
{
  // The exploit: set the clock forward a year, collect, set it back.
  const r = resolveAway({ wall: T0 - 365 * 86400_000 }, { now: T0 });
  ok('a year away is capped', r.capped && r.seconds === AWAY_CAP, JSON.stringify(r));
  ok('a year away still reports the raw span honestly', r.rawSeconds > 3e7);
}
{
  // The other half: clock set backwards must never pay out negative time.
  const r = resolveAway({ wall: T0 + 86400_000 }, { now: T0 });
  ok('a backwards clock credits nothing', r.seconds === 0, JSON.stringify(r));
  ok('a backwards clock is flagged', r.backwards);
}
for (const junk of [null, undefined, {}, { wall: NaN }, { wall: 'soon' }, { wall: 0 }, { wall: -5 }]) {
  const r = resolveAway(junk, { now: T0 });
  ok(`junk timestamp ${JSON.stringify(junk)} credits nothing`, r.seconds === 0 && Number.isFinite(r.seconds));
}
{
  const r = resolveAway({ wall: T0 - 5000 }, { now: T0 });
  ok('a five-second gap credits five seconds', Math.abs(r.seconds - 5) < 0.01);
}
ok('resolveAway never returns a non-finite credit',
  [0, 1, 1e12, -1e12, 1e300].every((d) => Number.isFinite(resolveAway({ wall: T0 - d }, { now: T0 }).seconds)));

ok('humanDuration(0)', humanDuration(0) === '0 SECONDS', humanDuration(0));
ok('humanDuration(1)', humanDuration(1) === '1 SECOND', humanDuration(1));
ok('humanDuration(90)', humanDuration(90) === '1 MINUTE', humanDuration(90));
ok('humanDuration(3700)', humanDuration(3700) === '1 HOUR, 1 MINUTE', humanDuration(3700));
ok('humanDuration(cap)', /HOUR/.test(humanDuration(AWAY_CAP)), humanDuration(AWAY_CAP));
ok('humanDuration is never empty', [0, 1, 59, 60, 3599, 86399, 1e7].every((s) => humanDuration(s).length > 0));
ok('humanDuration handles negatives', humanDuration(-100) === '0 SECONDS', humanDuration(-100));

// ------------------------------------------------------------------ report
const QUIET = process.argv.includes('--quiet');
if (!QUIET) console.log(results.join('\n'));
else console.log(results.filter((r) => r.includes('FAIL')).join('\n'));
console.log(`\n${pass}/${pass + fail} checks passed${fail ? `  \x1b[31m(${fail} FAILED)\x1b[0m` : ''}\n`);
process.exit(fail ? 1 : 0);
