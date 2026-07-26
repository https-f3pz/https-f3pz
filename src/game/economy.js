// The whole game.
//
// Imports core/big.js and core/awaytime.js and NOTHING else — no canvas, no
// DOM, no audio, no input. That is what lets tools/balance.mjs run thirty
// simulated days in Node in a couple of seconds, and it is the single most
// valuable property of this file. Keep it.
//
// ---------------------------------------------------------------------------
// THE ONE INVARIANT
// ---------------------------------------------------------------------------
// A ladder where tier k produces tier k-1 and every 20 purchases multiplies a
// tier's output has a feedback loop through itself. Its gain is
//
//     g(S) = (log10(MILE_MULT) / MILE_EVERY) * sum_{k=1..S} 1 / log10(r_k)
//
// and depth then grows as t^P where P = S / (1 - g). If g reaches 1 the
// economy diverges in finite time and the game is over in an afternoon. Every
// constant below is chosen to keep g comfortably under it, and three rules
// follow that must never be broken:
//
//   1. Nothing may ever change MILE_MULT, MILE_EVERY or any r_k. In particular
//      there is no cost-reduction upgrade anywhere in this game, because
//      lowering a ratio RAISES g. A mere 2% cut to every ratio tips it over.
//   2. Any multiplier bought with a prestige currency at geometric cost for
//      geometric benefit adds log(benefit)/log(cost) to the prestige feedback
//      exponent, and must therefore be hard-capped. OVERDRIVE is capped at 12.
//   3. No unbounded Big lifetime sum may drive anything visual or structural.
//      Big holds ~16 significant digits, so once an accumulator reaches 1e4628
//      adding 1e300 to it two hundred thousand times leaves it at exactly
//      1e4628 — silently, with no NaN and no error. Prestige currencies are
//      safe because each award is a large fraction of the total; a running
//      visual clock is not. SCALE is a plain float built from max() and
//      integer counters only.
//
// tools/balance.mjs asserts all of this on every run.

import * as B from '../core/big.js';
import { resolveAway } from '../core/awaytime.js';
import { TIERS, LADDER, MILE_MULT, MILE_EVERY, PEXP, TEXP, DRIFT_MULT, OVERDRIVE, GATE, AUTO, GOV_STEPS, PRESTIGE_STEPS, CHALLENGES, AWAY } from './config.js';

const MAX_TIERS = LADDER.length;

// --------------------------------------------------------------- the ladder

/** Base cost of a tier's first unit: 1e1, 1e2, 1e4, 1e7, 1e11, ... */
export function baseCost(k) {
  return B.pow10(1 + (k * (k - 1)) / 2);
}

/** Cost growth ratio for a tier. Frozen forever — see rule 1. */
export function ratio(k) {
  return 1.15 + 0.026 * (k - 1);
}

/** Loop gain at S tiers. Must stay well under 1. */
export function loopGain(S) {
  let sum = 0;
  for (let k = 1; k <= S; k++) sum += 1 / Math.log10(ratio(k));
  return (Math.log10(MILE_MULT) / MILE_EVERY) * sum;
}

/** The exponent depth actually grows with: depth ~ t^P. */
export function timeExponent(S) {
  return S / (1 - loopGain(S));
}

/** Prestige feedback. Over 1 and prestige currency outruns its own cost. */
export function prestigeFeedback(S) {
  return (PEXP / (1 - loopGain(S))) * (1 + TEXP * Math.log10(DRIFT_MULT));
}

// ----------------------------------------------------------------- state

export function newState(opts = {}) {
  const st = {
    tiers: TIERS.base,
    count: [], // count[k] — Big. Units held, including those produced for you.
    owned: [], // owned[k] — plain int. Units BOUGHT: drives cost and milestones.
    depth: B.big(10),
    photons: { bank: B.ZERO, life: B.ZERO },
    tau: { bank: B.ZERO, life: B.ZERO },
    omega: { total: 0, bore: 0, drift: 0, stasis: 0 },
    auto: { drive: [], bulk: false, governor: false, collapse: false, dilate: false, overdrive: 0 },
    gov: 0, // index into GOV_STEPS: fraction of depth held back for big tiers
    thr: { collapse: 0, dilate: 0 }, // indices into PRESTIGE_STEPS
    collapses: 0,
    dilates: 0,
    horizons: 0,
    peakLogRate: 0,
    bestCycleLog: 0,
    challenge: null, // { id, targetLog }
    done: {}, // completed challenge ids
    // Bounded history of absence lengths, used to pick PRIME's horizon.
    aways: [],
    events: [],
  };
  for (let k = 0; k <= MAX_TIERS; k++) {
    st.count[k] = B.ZERO;
    st.owned[k] = 0;
    st.auto.drive[k] = false;
  }
  // One free INTAKE, so the bore is ALREADY falling when the app first opens.
  // Without it a new save has a production rate of exactly zero and the game
  // sits dead until the player finds the buy button — a cold start that reads
  // as a broken app, and one the fiction flatly contradicts.
  st.owned[1] = 1;
  st.count[1] = B.ONE;
  if (opts.tiers) st.tiers = opts.tiers;
  return st;
}

function emit(st, type, a, b) {
  if (st.events.length < 64) st.events.push({ type, a, b });
}

// ------------------------------------------------------------ multipliers

/** Milestone multiplier for a tier: x1.20 per 20 bought. */
export function milestone(st, k) {
  let steps = Math.floor(st.owned[k] / MILE_EVERY);
  // NO MILESTONES challenge zeroes these; its reward is a permanent free step.
  if (st.challenge?.id === 'nomiles') steps = 0;
  if (st.done.nomiles) steps += 1;
  return B.pow10(Math.log10(MILE_MULT) * steps);
}

/** The global output multiplier M, applied to tier 1 only. */
export function globalMult(st) {
  let m = B.add(B.ONE, st.photons.life);
  m = B.mul(m, B.pow10(Math.log10(OVERDRIVE.mult) * st.auto.overdrive));
  m = B.mul(m, B.pow10(Math.log10(DRIFT_MULT) * st.omega.drift));
  if (st.done.deadreck) m = B.mulNum(m, 1.5);
  return m;
}

/** Seconds of proper time per second of wall time. Damped by construction. */
export function dilation(st) {
  if (st.challenge?.id === 'flattime') return 1;
  const coef = st.done.flattime ? 0.55 : 0.5;
  return 1 + coef * Math.log10(1 + B.toNumber(B.min(st.tau.life, B.bigFrom(1, 300))));
}

/**
 * Per-tier production coefficients. A[k] is how fast one unit of tier k makes
 * tier k-1 (and A[1] is how fast tier 1 makes depth).
 */
function coeffs(st) {
  const A = [B.ZERO];
  const M = globalMult(st);
  for (let k = 1; k <= st.tiers; k++) {
    const mk = milestone(st, k);
    A[k] = k === 1 ? B.mul(mk, M) : mk;
  }
  return A;
}

// ------------------------------------------------------------- the integral
//
// The state is a strictly triangular linear system — tier k drives tier k-1 and
// nothing drives tier S — so it is nilpotent, and the exact solution is a
// FINITE Taylor polynomial with no truncation error at any t:
//
//   Q_k(t) = sum_{j=0..S-k}  Q_{k+j}(0) * (prod_{i=1..j} A_{k+i}) * t^j / j!
//   D(t)   = D(0) + sum_{j=0..S-1} Q_{1+j}(0) * (prod_{i=0..j} A_{1+i}) * t^(j+1)/(j+1)!
//
// This is why offline progress is honest rather than approximated: the same
// function runs with t = 1/20 during play and t = 60 per chunk while you were
// gone, and produces the same answer. It is also why rates may only change at
// purchase boundaries — every buy MUST force a boundary, or the polynomial is
// integrating a coefficient that already changed.

export function advance(st, t) {
  if (!(t > 0)) return;
  const S = st.tiers;
  const A = coeffs(st);
  const Q = st.count;

  // Depth first, because it reads the OLD counts.
  {
    let prod = A[1];
    let tp = B.big(t); // t^(j+1) / (j+1)!
    let acc = B.mul(B.mul(Q[1], prod), tp);
    for (let j = 1; j <= S - 1; j++) {
      prod = B.mul(prod, A[1 + j]);
      tp = B.mulNum(tp, t / (j + 1));
      acc = B.add(acc, B.mul(B.mul(Q[1 + j], prod), tp));
    }
    st.depth = B.add(st.depth, acc);
  }

  // Then every tier, all from the old vector.
  const next = [B.ZERO];
  for (let k = 1; k <= S; k++) {
    let acc = Q[k];
    let prod = B.ONE;
    let tp = B.ONE;
    for (let j = 1; j <= S - k; j++) {
      prod = B.mul(prod, A[k + j]);
      tp = B.mulNum(tp, t / j);
      acc = B.add(acc, B.mul(B.mul(Q[k + j], prod), tp));
    }
    next[k] = acc;
  }
  for (let k = 1; k <= S; k++) Q[k] = next[k];

  // Rate is a plain float, and peakLogRate is a max() — never a Big sum.
  const rate = B.mul(B.mul(Q[1], A[1]), B.ONE);
  const lr = B.log10(rate);
  if (Number.isFinite(lr) && lr > st.peakLogRate) st.peakLogRate = lr;
}

/** Current depth gain per second, as a Big. */
export function rate(st) {
  const A = coeffs(st);
  return B.mul(st.count[1], A[1]);
}

// ------------------------------------------------------------- purchasing

export function costFor(st, k, n = 1) {
  return B.costRange(baseCost(k), ratio(k), st.owned[k], n);
}

export function canAfford(st, k, n = 1) {
  return B.lte(costFor(st, k, n), st.depth);
}

/**
 * Depth this tier is allowed to spend. GOVERNOR holds a fraction back so a
 * cheap tier's autobuyer cannot starve an expensive one that is nearly
 * affordable — the classic idle failure where tier 1 eats everything forever.
 * The top tier is always allowed the full bank.
 */
/**
 * The highest tier currently affordable at all. Computed once per buying pass
 * rather than per purchase — it is the input to the reserve decision, and
 * recomputing it inside every buy() turned a 30-day simulation into minutes.
 */
export function topAffordable(st) {
  for (let k = st.tiers; k >= 1; k--) {
    if (B.lte(costFor(st, k, 1), st.depth)) return k;
  }
  return 0;
}

function budgetFor(st, k, hi) {
  const reserve = st.auto.governor ? GOV_STEPS[st.gov] : 0;
  if (reserve <= 0 || k >= st.tiers) return st.depth;
  // Hold depth back ONLY if a more expensive tier could actually spend it.
  //
  // Without this test the governor deadlocks the game outright: straight after
  // a collapse the bank is exactly 10, tier 1 costs exactly 10, a 25% reserve
  // allows only 7.5, and every tier above is astronomically out of reach. The
  // result is depth 10 and a production rate of zero, forever, with no error —
  // a save bricked by a feature that was meant to help.
  const top = hi ?? topAffordable(st);
  if (k >= top) return st.depth;
  return B.mulNum(st.depth, 1 - reserve);
}

/** Buy up to `n` of tier k (Infinity for max). Returns how many were bought. */
export function buy(st, k, n = 1, opts = {}) {
  if (k < 1 || k > st.tiers) return 0;
  if (st.challenge?.id === 'coldbore' && k >= 5) return 0;
  const budget = opts.full ? st.depth : budgetFor(st, k, opts.hi);
  const want = n === Infinity ? B.affordable(baseCost(k), ratio(k), st.owned[k], budget) : n;
  if (want <= 0) return 0;
  const cost = B.costRange(baseCost(k), ratio(k), st.owned[k], want);
  if (B.gt(cost, st.depth)) return 0;

  st.depth = B.sub(st.depth, cost);
  const before = Math.floor(st.owned[k] / MILE_EVERY);
  st.owned[k] += want;
  st.count[k] = B.add(st.count[k], B.big(want));
  const after = Math.floor(st.owned[k] / MILE_EVERY);
  if (after > before) emit(st, 'milestone', k, after);
  emit(st, 'buy', k, want);
  return want;
}

/** Buy-max across every tier, most expensive first so GOVERNOR means something. */
export function maxAll(st) {
  let total = 0;
  const hi = topAffordable(st);
  for (let k = st.tiers; k >= 1; k--) total += buy(st, k, Infinity, { hi });
  return total;
}

/** Autobuyers, one pass. Called every tick online and every chunk offline. */
export function runAutobuyers(st) {
  if (st.challenge?.id === 'deadreck') return;
  const hi = topAffordable(st);
  for (let k = st.tiers; k >= 1; k--) {
    if (!st.auto.drive[k]) continue;
    buy(st, k, st.auto.bulk ? Infinity : 1, { hi });
  }
}

// ---------------------------------------------------------------- prestige

export function collapseGain(st) {
  if (B.lt(st.depth, GATE.collapse)) return B.ZERO;
  const g = B.pow(B.div(st.depth, GATE.collapse), PEXP);
  return B.max(B.ONE, floorBig(g));
}

export function canCollapse(st) {
  return B.gte(st.depth, GATE.collapse);
}

export function collapse(st, opts = {}) {
  if (!canCollapse(st)) return B.ZERO;
  const gain = collapseGain(st);
  const cycleLog = B.log10(st.depth);
  if (cycleLog > st.bestCycleLog) st.bestCycleLog = cycleLog;

  // A challenge run pays its prize instead of photons.
  if (st.challenge && !opts.abandon) {
    if (cycleLog >= st.challenge.targetLog) {
      st.done[st.challenge.id] = true;
      emit(st, 'challengeDone', st.challenge.id);
    }
    st.challenge = null;
  } else {
    st.photons.bank = B.add(st.photons.bank, gain);
    st.photons.life = B.add(st.photons.life, gain);
  }

  resetLadder(st);
  st.collapses++;
  emit(st, 'collapse', gain);
  return gain;
}

function resetLadder(st) {
  st.depth = B.big(10);
  for (let k = 0; k <= MAX_TIERS; k++) {
    st.count[k] = B.ZERO;
    st.owned[k] = 0;
  }
  // The free INTAKE is restored on every reset, for the same reason it exists
  // at all: a collapse must never leave the bore stationary.
  st.owned[1] = 1;
  st.count[1] = B.ONE;

  // Challenge rewards are free purchases, granted on every reset.
  const free = (st.done.coldbore ? 4 : 0);
  const all = (st.done.singlefile ? 2 : 0);
  for (let k = 1; k <= st.tiers; k++) {
    const n = (k <= 4 ? free : 0) + all;
    if (n > 0) {
      st.owned[k] += n;
      st.count[k] = B.add(st.count[k], B.big(n));
    }
  }
}

export function dilateGain(st) {
  if (B.lt(st.photons.life, GATE.dilate)) return B.ZERO;
  return B.max(B.ONE, floorBig(B.pow(B.div(st.photons.life, GATE.dilate), PEXP)));
}

export function canDilate(st) {
  return B.gte(st.photons.life, GATE.dilate);
}

export function dilate(st) {
  if (!canDilate(st)) return B.ZERO;
  const gain = dilateGain(st);
  st.tau.bank = B.add(st.tau.bank, gain);
  st.tau.life = B.add(st.tau.life, gain);
  // Resets the entire photon layer, including every autobuyer bought with it.
  st.photons.bank = B.ZERO;
  st.photons.life = B.ZERO;
  for (let k = 0; k <= MAX_TIERS; k++) st.auto.drive[k] = false;
  st.auto.bulk = false;
  st.auto.governor = false;
  st.auto.collapse = false;
  st.auto.overdrive = 0;
  st.challenge = null;
  resetLadder(st);
  st.dilates++;
  emit(st, 'dilate', gain);
  return gain;
}

/** Omega is granted by total tau, one per decade past the gate. */
export function omegaFor(tauLife) {
  const l = B.log10(B.add(B.ONE, tauLife));
  if (!Number.isFinite(l)) return 0;
  return Math.max(0, Math.floor(l) - 5);
}

export function canHorizon(st) {
  return omegaFor(st.tau.life) > st.omega.total;
}

export function horizon(st) {
  const total = omegaFor(st.tau.life);
  if (total <= st.omega.total) return 0;
  const gained = total - st.omega.total;
  st.omega.total = total;
  st.tau.bank = B.ZERO;
  st.tau.life = B.ZERO;
  st.auto.dilate = false;
  st.photons.bank = B.ZERO;
  st.photons.life = B.ZERO;
  for (let k = 0; k <= MAX_TIERS; k++) st.auto.drive[k] = false;
  st.auto.bulk = false;
  st.auto.governor = false;
  st.auto.collapse = false;
  st.auto.overdrive = 0;
  st.challenge = null;
  resetLadder(st);
  st.horizons++;
  emit(st, 'horizon', gained);
  return gained;
}

/** Omega is allocated, never spent — free and reversible at any time. */
export function allocate(st, sink, delta) {
  const caps = { bore: TIERS.max - TIERS.base, drift: Infinity, stasis: AWAY.stasisMax };
  const spent = st.omega.bore + st.omega.drift + st.omega.stasis;
  const free = st.omega.total - spent;
  if (delta > 0 && free <= 0) return false;
  const next = st.omega[sink] + delta;
  if (next < 0 || next > caps[sink]) return false;
  st.omega[sink] = next;
  st.tiers = TIERS.base + st.omega.bore;
  // Growing the ladder must initialise the new tier, or it holds undefined.
  for (let k = 0; k <= MAX_TIERS; k++) {
    if (!st.count[k]) st.count[k] = B.ZERO;
    if (st.owned[k] == null) st.owned[k] = 0;
  }
  return true;
}

// -------------------------------------------------------------- challenges

export function enterChallenge(st, id) {
  const ch = CHALLENGES.find((c) => c.id === id);
  if (!ch || st.done[id]) return false;
  // Target is fixed at entry, so one banked for a quiet week is the same
  // difficulty whenever you get to it.
  st.challenge = { id, targetLog: Math.max(8, st.bestCycleLog * 0.6) };
  resetLadder(st);
  return true;
}

export function exitChallenge(st) {
  if (!st.challenge) return;
  st.challenge = null;
  resetLadder(st);
}

// ------------------------------------------------------- prestige automation

function autoPrestige(st) {
  if (st.auto.collapse && !st.challenge) {
    const mult = PRESTIGE_STEPS[st.thr.collapse];
    const gain = collapseGain(st);
    // Fire when the pending award is `mult` times what is already banked, so
    // every award is a large fraction of the running total — which is exactly
    // what keeps the lifetime sum away from the Big precision floor (rule 3).
    if (B.gt(gain, B.ZERO) && B.gte(gain, B.mulNum(B.max(st.photons.bank, B.ONE), mult))) {
      collapse(st);
    }
  }
  if (st.auto.dilate) {
    const mult = PRESTIGE_STEPS[st.thr.dilate];
    const gain = dilateGain(st);
    if (B.gt(gain, B.ZERO) && B.gte(gain, B.mulNum(B.max(st.tau.bank, B.ONE), mult))) {
      dilate(st);
    }
  }
}

// ------------------------------------------------------------------ ticking

/**
 * One step of `t` seconds of PROPER time, followed by the automation pass.
 * Purchases force the boundary the closed form needs.
 */
export function step(st, t) {
  advance(st, t);
  runAutobuyers(st);
  autoPrestige(st);
}

/** Wall seconds -> proper seconds. Tau buys time itself. */
export function properTime(st, wallSeconds) {
  return wallSeconds * dilation(st);
}

// --------------------------------------------------------------- offline

export function awayCapSeconds(st) {
  return AWAY.baseCap + AWAY.perStasis * st.omega.stasis;
}

/**
 * Resolve an absence into progress.
 *
 * Split into fixed 60-second chunks ALWAYS, so identical absences give
 * identical results and the value of away time is smooth in duration. One
 * single chunk of 36h would be worth almost nothing (the autobuyers never
 * fire); 60s is where the curve flattens.
 *
 * Returns a ledger for the away panel. Pass `budget` through from the save.
 */
export function resolveOffline(st, clock, opts = {}) {
  const cap = awayCapSeconds(st);
  const r = resolveAway(clock, { cap, now: opts.now });

  const ledger = {
    seconds: 0,
    rawSeconds: r.rawSeconds,
    capped: r.capped,
    backwards: r.backwards,
    missing: r.missing,
    throttled: false,
    depthBefore: st.depth,
    collapsesBefore: st.collapses,
    dilatesBefore: st.dilates,
    properSeconds: 0,
    chunks: 0,
  };
  if (r.seconds <= 0) return ledger;

  // Refilling budget bucket. An honest player is never limited: an 8h absence
  // spends 28,800s from a bucket that refilled by 36,000. But a clock jumped
  // forward repeatedly can only ever extract what real time has refilled, so
  // total extraction is bounded to ~30h of progress per 24h of real time no
  // matter what the device clock does — including the case the monotonic
  // cross-check structurally cannot see, because it is not running.
  const elapsed = Math.max(0, r.rawSeconds);
  let bucket = Number.isFinite(clock?.budget) ? clock.budget : cap;
  bucket = Math.min(cap, bucket + elapsed * AWAY.refill);
  const credit = Math.min(cap, r.seconds, bucket);
  bucket -= credit;
  ledger.throttled = credit < r.seconds - 1;
  ledger.budget = bucket;
  ledger.high = r.high;
  ledger.seconds = credit;
  if (credit <= 0) return ledger;

  // Chunked, in proper time. Dilation is re-read each chunk because a collapse
  // inside the absence can change it.
  let left = credit;
  while (left > 0) {
    const w = Math.min(AWAY.chunk, left);
    left -= w;
    const p = properTime(st, w);
    ledger.properSeconds += p;
    step(st, p);
    ledger.chunks++;
  }

  ledger.depthAfter = st.depth;
  ledger.collapsesRun = st.collapses - ledger.collapsesBefore;
  ledger.dilatesRun = st.dilates - ledger.dilatesBefore;

  // Remember how long this player tends to be away; PRIME uses the median to
  // pick a purchase horizon. Bounded list — never an unbounded accumulator.
  st.aways.push(Math.round(credit));
  if (st.aways.length > 8) st.aways.shift();

  return ledger;
}

/** Median recent absence, clamped. The horizon PRIME optimises over. */
export function primeHorizon(st) {
  if (!st.aways.length) return AUTO.horizonDefault;
  const s = [...st.aways].sort((a, b) => a - b);
  const m = s[s.length >> 1];
  return Math.min(AUTO.horizonMax, Math.max(AUTO.horizonMin, m));
}

/**
 * The single best purchase right now: the one that most improves projected
 * depth over the player's own horizon, per unit of depth spent.
 *
 * Evaluated with the same closed form as everything else, on a shallow copy,
 * so it can never be wrong about what a purchase would do.
 */
export function primePick(st) {
  const H = primeHorizon(st);
  const baseline = project(st, H);
  let best = null;
  for (let k = 1; k <= st.tiers; k++) {
    if (st.challenge?.id === 'coldbore' && k >= 5) continue;
    const cost = costFor(st, k, 1);
    if (B.gt(cost, st.depth)) continue;
    const trial = cloneLight(st);
    buy(trial, k, 1, { full: true });
    const after = project(trial, H);
    // Compare in log space: these differ by hundreds of decades.
    const gain = B.log10(after) - B.log10(baseline);
    const price = B.log10(cost);
    const score = gain / Math.max(1, price);
    if (!Number.isFinite(score)) continue;
    if (!best || score > best.score) best = { k, score, cost, gain };
  }
  return best;
}

/** Projected depth after `t` seconds of proper time, without mutating. */
export function project(st, t) {
  const trial = cloneLight(st);
  advance(trial, t);
  return trial.depth;
}

function cloneLight(st) {
  return {
    ...st,
    count: st.count.slice(),
    owned: st.owned.slice(),
    photons: { ...st.photons },
    tau: { ...st.tau },
    omega: { ...st.omega },
    auto: { ...st.auto, drive: st.auto.drive.slice() },
    done: st.done,
    events: [],
  };
}

// ------------------------------------------------------------ serialisation
//
// Every Big goes to a string. JSON.stringify(Infinity) is `null`, and one null
// merged over a default silently poisons every comparison downstream forever.

export function serialize(st) {
  return {
    tiers: st.tiers,
    depth: B.toString(st.depth),
    count: st.count.map(B.toString),
    owned: st.owned.slice(),
    photons: { bank: B.toString(st.photons.bank), life: B.toString(st.photons.life) },
    tau: { bank: B.toString(st.tau.bank), life: B.toString(st.tau.life) },
    omega: { ...st.omega },
    auto: { ...st.auto, drive: st.auto.drive.slice() },
    gov: st.gov,
    thr: { ...st.thr },
    collapses: st.collapses,
    dilates: st.dilates,
    horizons: st.horizons,
    peakLogRate: st.peakLogRate,
    bestCycleLog: st.bestCycleLog,
    challenge: st.challenge ? { ...st.challenge } : null,
    done: { ...st.done },
    aways: st.aways.slice(-8),
  };
}

export function deserialize(raw) {
  const st = newState();
  if (!raw || typeof raw !== 'object') return st;
  const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);

  st.tiers = Math.min(TIERS.max, Math.max(TIERS.base, num(raw.tiers, TIERS.base)));
  st.depth = B.fromString(raw.depth ?? '10');
  if (B.isZero(st.depth)) st.depth = B.big(10);
  for (let k = 0; k <= MAX_TIERS; k++) {
    st.count[k] = B.fromString(raw.count?.[k] ?? '0');
    st.owned[k] = Math.max(0, Math.floor(num(raw.owned?.[k], 0)));
    st.auto.drive[k] = !!raw.auto?.drive?.[k];
  }
  st.photons.bank = B.fromString(raw.photons?.bank ?? '0');
  st.photons.life = B.fromString(raw.photons?.life ?? '0');
  st.tau.bank = B.fromString(raw.tau?.bank ?? '0');
  st.tau.life = B.fromString(raw.tau?.life ?? '0');
  for (const key of ['total', 'bore', 'drift', 'stasis']) {
    st.omega[key] = Math.max(0, Math.floor(num(raw.omega?.[key], 0)));
  }
  st.auto.bulk = !!raw.auto?.bulk;
  st.auto.governor = !!raw.auto?.governor;
  st.auto.collapse = !!raw.auto?.collapse;
  st.auto.dilate = !!raw.auto?.dilate;
  st.auto.overdrive = Math.min(OVERDRIVE.levels, Math.max(0, Math.floor(num(raw.auto?.overdrive, 0))));
  st.gov = Math.min(GOV_STEPS.length - 1, Math.max(0, Math.floor(num(raw.gov, 0))));
  st.thr.collapse = Math.min(PRESTIGE_STEPS.length - 1, Math.max(0, Math.floor(num(raw.thr?.collapse, 0))));
  st.thr.dilate = Math.min(PRESTIGE_STEPS.length - 1, Math.max(0, Math.floor(num(raw.thr?.dilate, 0))));
  st.collapses = Math.max(0, Math.floor(num(raw.collapses, 0)));
  st.dilates = Math.max(0, Math.floor(num(raw.dilates, 0)));
  st.horizons = Math.max(0, Math.floor(num(raw.horizons, 0)));
  st.peakLogRate = num(raw.peakLogRate, 0);
  st.bestCycleLog = num(raw.bestCycleLog, 0);
  st.done = raw.done && typeof raw.done === 'object' ? { ...raw.done } : {};
  st.aways = Array.isArray(raw.aways) ? raw.aways.filter((n) => Number.isFinite(n)).slice(-8) : [];
  if (raw.challenge && CHALLENGES.some((c) => c.id === raw.challenge.id)) {
    st.challenge = { id: raw.challenge.id, targetLog: num(raw.challenge.targetLog, 8) };
  }
  // The allocation may have been saved against a different cap; re-derive.
  st.tiers = TIERS.base + Math.min(TIERS.max - TIERS.base, st.omega.bore);
  return st;
}

// ------------------------------------------------------------------ helpers

/** floor() for a Big. Only meaningful below 1e15; above it, already integral. */
export function floorBig(a) {
  if (a.e > 15) return a;
  const n = Math.floor(B.toNumber(a));
  return B.big(n);
}

/** Log-space fraction for a meter. Every bar in this game is log-scaled. */
export function logFrac(x, lo, hi) {
  const a = B.log10(B.big(x));
  const l = Math.log10(lo);
  const h = Math.log10(hi);
  if (!Number.isFinite(a) || h <= l) return 0;
  return Math.min(1, Math.max(0, (a - l) / (h - l)));
}
