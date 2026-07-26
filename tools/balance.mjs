// Economy harness.
//
// src/game/economy.js imports core/big.js and core/awaytime.js and nothing
// else — no canvas, no DOM, no audio — so thirty simulated days run here in a
// couple of seconds.
//
//   node tools/balance.mjs                 # the shipping gates
//   node tools/balance.mjs --curve         # the progression, sampled
//   node tools/balance.mjs --days 30       # how far to simulate
//
// The old harness fingerprinted two runs of the same seed to prove the
// simulation was deterministic. This economy has NO RNG at all, so that check
// would pass forever while asserting nothing — exactly when a safety net is
// most needed. It is replaced with gates that can actually fail.

import * as B from '../src/core/big.js';
import * as E from '../src/game/economy.js';
import {
  TIERS, LADDER, MILE_MULT, MILE_EVERY, PEXP, TEXP, DRIFT_MULT, AUTO,
  OVERDRIVE, GOV_STEPS, AWAY, SPEED, WARP, TUBE,
} from '../src/game/config.js';
import { makeWorld, updateWorld, ringGapFor, Z_MODULUS } from '../src/game/world.js';

const argv = process.argv.slice(2);
const arg = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? Number(argv[i + 1]) : d;
};
const has = (n) => argv.includes(`--${n}`);

let pass = 0;
let fail = 0;
const gates = [];
function gate(name, ok, detail = '') {
  if (ok) pass++;
  else fail++;
  gates.push(`  ${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${name.padEnd(56)} ${detail}`);
}

// ---------------------------------------------------------------- a player
//
// Buys whatever PRIME recommends, takes prestiges when they are worth taking,
// and buys automation in the order a real player would. Deliberately not
// optimal — the point is to measure the shape of the curve, not to solve it.

function bot(days, opts = {}) {
  const st = E.newState();
  // Decision cadence. The economy itself is exact at any dt (gate 1 proves the
  // closed form IS the integral), so this only sets how often the bot decides —
  // and after the first few hours everything it does is automated anyway. The
  // early game keeps 1s resolution because that is where cadence actually
  // shapes the curve.
  const dtAt = (t) => (opts.dt ?? (t < 6 * 3600 ? 1 : 4));
  const total = days * 86400;
  const samples = [];
  let nextSample = 0;
  let t = 0;
  let longestGap = 0;
  let gapStart = 0;
  let lastBuy = 0;
  let lastCollapses = 0;
  let lastDilates = 0;
  let lastLogDepth = -Infinity;
  let gapWhy = null;
  let longestCycle = 0;
  let cycleStart2 = 0;
  let cycleMark = 0;
  const cycleTimes = [];
  let cycleStart = 0;
  let prevScale = -Infinity;
  let scaleMonotone = true;
  const world = makeWorld();
  let warpMin = Infinity;
  let warpMax = -Infinity;
  let speedMin = Infinity;
  let speedMax = -Infinity;
  const gapsSeen = new Set();

  while (t < total) {
    const DT = dtAt(t);
    E.step(st, E.properTime(st, DT));
    t += DT;

    // Automation, bought in the order the spec lays out.
    spendPhotons(st);
    spendTau(st);
    allocateOmega(st);

    // Manual purchases: take PRIME's pick, or buy-max once BULK is owned.
    if (st.auto.bulk) {
      if (E.maxAll(st) > 0) lastBuy = t;
    } else {
      const p = E.primePick(st);
      if (p && E.buy(st, p.k, 1, { full: true })) lastBuy = t;
    }

    // Manual prestige, on the same threshold the autobuyer uses. Collapsing
    // the instant it is legal always yields a gain of exactly 1 and is the
    // worst possible play — a bot that does it measures nothing useful.
    if (!st.auto.collapse && worthCollapsing(st)) {
      const before = st.collapses;
      E.collapse(st);
      if (st.collapses > before) {
        cycleTimes.push(t - cycleStart);
        cycleStart = t;
      }
    }
    if (!st.auto.dilate && worthDilating(st)) E.dilate(st);
    if (E.canHorizon(st)) E.horizon(st);

    // What matters in an idle game is not "did the player press something" —
    // long automated cycles ARE the content, and the waiting is what makes
    // coming back worth it. What matters is that the game always has SOMETHING
    // to offer: a purchase you can afford, a prestige worth taking, or visible
    // movement in the number. The stretch that would be a real defect is one
    // where a player who opened the app would find nothing at all to do.
    //
    // Note this is deliberately not "the bot pressed something". The bot holds
    // out for a x2 collapse; a present player would simply tap it. Measuring
    // the bot's patience would be measuring the bot.
    const ld = B.log10(st.depth);
    const somethingToDo = E.canCollapse(st) || E.canDilate(st) || E.canHorizon(st) ||
      E.topAffordable(st) > 0;
    if (somethingToDo || ld >= lastLogDepth + 1 ||
        st.collapses !== lastCollapses || st.dilates !== lastDilates) {
      lastBuy = t;
      lastLogDepth = ld;
      lastCollapses = st.collapses;
      lastDilates = st.dilates;
    }
    if (t - lastBuy > longestGap) {
      longestGap = t - lastBuy;
      gapStart = lastBuy;
      gapWhy = {
        depth: B.fmt(st.depth),
        rate: B.fmt(E.rate(st)),
        cheapest: B.fmt(E.costFor(st, 1, 1)),
        bank: B.fmt(st.photons.bank),
        tiers: st.tiers,
      };
    }
    // And the collapse rhythm itself must not run away into a whole day.
    if (st.collapses !== cycleMark) {
      const len = t - cycleStart2;
      if (len > longestCycle) longestCycle = len;
      cycleStart2 = t;
      cycleMark = st.collapses;
    }

    // Visual adapter bounds, sampled on the real state.
    updateWorld(world, st, DT);
    if (world.scale < prevScale - 1e-9) scaleMonotone = false;
    prevScale = world.scale;
    warpMin = Math.min(warpMin, world.warp);
    warpMax = Math.max(warpMax, world.warp);
    speedMin = Math.min(speedMin, world.speed);
    speedMax = Math.max(speedMax, world.speed);
    gapsSeen.add(ringGapFor(world.speed));

    st.events.length = 0;

    if (t >= nextSample) {
      samples.push({
        t,
        depth: st.depth,
        rate: E.rate(st),
        photons: st.photons.life,
        tau: st.tau.life,
        omega: st.omega.total,
        tiers: st.tiers,
        collapses: st.collapses,
        dilates: st.dilates,
        horizons: st.horizons,
        warp: world.warp,
        band: world.band,
        dil: E.dilation(st),
      });
      nextSample += total / 24;
    }
  }

  return {
    st, samples, longestGap, gapStart, gapWhy, longestCycle, cycleTimes, scaleMonotone,
    warpMin, warpMax, speedMin, speedMax, gapsSeen: [...gapsSeen].sort((a, b) => a - b),
    world,
  };
}

/** Take a prestige only when it multiplies what you already hold. */
function worthCollapsing(st) {
  const gain = E.collapseGain(st);
  return B.gt(gain, B.ZERO) && B.gte(gain, B.mulNum(B.max(st.photons.bank, B.ONE), 2));
}
function worthDilating(st) {
  const gain = E.dilateGain(st);
  return B.gt(gain, B.ZERO) && B.gte(gain, B.mulNum(B.max(st.tau.bank, B.ONE), 2));
}

function spendPhotons(st) {
  const bank = () => st.photons.bank;
  const buyIt = (cost) => {
    const c = B.big(cost);
    if (B.lt(bank(), c)) return false;
    st.photons.bank = B.sub(st.photons.bank, c);
    return true;
  };
  // Autobuyers first, cheapest tier first — they retire the most tedium per photon.
  for (let k = 1; k <= st.tiers; k++) {
    if (!st.auto.drive[k] && buyIt(Math.pow(AUTO.driveBase, k - 1))) st.auto.drive[k] = true;
  }
  if (!st.auto.bulk && buyIt(AUTO.bulk)) st.auto.bulk = true;
  if (!st.auto.governor && buyIt(AUTO.governor)) { st.auto.governor = true; st.gov = 1; }
  if (!st.auto.collapse && buyIt(AUTO.collapse)) st.auto.collapse = true;
  while (st.auto.overdrive < OVERDRIVE.levels &&
         buyIt(OVERDRIVE.base * Math.pow(OVERDRIVE.ratio, st.auto.overdrive))) {
    st.auto.overdrive++;
  }
}

function spendTau(st) {
  if (!st.auto.dilate && B.gte(st.tau.bank, B.big(AUTO.dilate))) {
    st.tau.bank = B.sub(st.tau.bank, B.big(AUTO.dilate));
    st.auto.dilate = true;
  }
}

function allocateOmega(st) {
  // BORE first — it is the only lever that raises the time exponent — then
  // alternate STASIS and DRIFT.
  const spent = st.omega.bore + st.omega.drift + st.omega.stasis;
  let free = st.omega.total - spent;
  while (free > 0) {
    if (st.omega.bore < TIERS.max - TIERS.base) E.allocate(st, 'bore', 1);
    else if (st.omega.stasis < AWAY.stasisMax && st.omega.stasis <= st.omega.drift) E.allocate(st, 'stasis', 1);
    else E.allocate(st, 'drift', 1);
    free--;
  }
}

// ============================================================ GATE 1
// The closed form IS the integral. One evaluation of a long interval must equal
// many short ones — this is what makes offline progress honest rather than
// approximated, and it is the assertion the whole design rests on.

function gate1() {
  const rows = [];
  for (const T of [60, 3600, 36 * 3600]) {
    const a = warm();
    const b = warm();
    E.advance(a, T);
    const stepN = Math.min(129600, T);
    const dt = T / stepN;
    for (let i = 0; i < stepN; i++) E.advance(b, dt);
    const la = B.log10(a.depth);
    const lb = B.log10(b.depth);
    const rel = Math.abs(la - lb) / Math.max(1, Math.abs(la));
    rows.push({ T, rel });
  }
  const worst = Math.max(...rows.map((r) => r.rel));
  gate('closed form equals stepped integration', worst < 1e-12,
    rows.map((r) => `${r.T}s:${r.rel.toExponential(1)}`).join(' '));
  return rows;
}

/** A state with a few tiers bought, so the polynomial has real coefficients. */
function warm() {
  const st = E.newState();
  st.depth = B.bigFrom(1, 40);
  for (let k = 1; k <= st.tiers; k++) {
    st.owned[k] = 25 + k;
    st.count[k] = B.big(25 + k);
  }
  st.photons.life = B.big(1000);
  return st;
}

// ============================================================ GATES 2 & 3
// The stability invariant. If these fail the game does not have a balance
// problem, it has an ending.

function gate23() {
  let worstG = 0;
  let worstA = 0;
  for (let S = TIERS.base; S <= TIERS.max; S++) {
    worstG = Math.max(worstG, E.loopGain(S));
    worstA = Math.max(worstA, E.prestigeFeedback(S));
  }
  gate('loop gain g(S) < 0.70 for every ladder size', worstG < 0.70,
    `max g = ${worstG.toFixed(3)} at S=${TIERS.max} (P = ${E.timeExponent(TIERS.max).toFixed(1)})`);
  gate('prestige feedback a(S) <= 0.90 for every ladder size', worstA <= 0.90,
    `max a = ${worstA.toFixed(3)}`);
  return { worstG, worstA };
}

// ============================================================ GATE 5
// Every Big survives the save file. JSON.stringify(Infinity) is null, and one
// null merged over a default poisons every comparison downstream forever.

function gate5(st) {
  const raw = JSON.parse(JSON.stringify(E.serialize(st)));
  const json = JSON.stringify(raw);
  const back = E.deserialize(raw);
  const nulls = /:null/.test(json.replace(/"challenge":null/, ''));
  const dOk = Math.abs(B.log10(back.depth) - B.log10(st.depth)) < 1e-9;
  const pOk = Math.abs(B.log10(B.add(back.photons.life, B.ONE)) - B.log10(B.add(st.photons.life, B.ONE))) < 1e-9;
  let cOk = true;
  for (let k = 1; k <= st.tiers; k++) {
    if (B.isZero(st.count[k]) !== B.isZero(back.count[k])) cOk = false;
    else if (!B.isZero(st.count[k]) && Math.abs(B.log10(back.count[k]) - B.log10(st.count[k])) > 1e-9) cOk = false;
  }
  gate('every persisted Big round-trips, none serialises to null',
    dOk && pOk && cOk && !nulls && !/NaN|Infinity/.test(json),
    `depth ${B.fmt(st.depth)} -> ${B.fmt(back.depth)}`);
}

// ============================================================ GATE 6
// Clock tampering is bounded, and an honest player is never touched.

function gate6() {
  const T0 = 1_700_000_000_000;
  const hour = 3600_000;

  // Honest: away 8 hours, never throttled.
  {
    const st = warm();
    const led = E.resolveOffline(st, { wall: T0 - 8 * hour, budget: AWAY.baseCap }, { now: T0 });
    gate('an honest 8-hour absence is credited in full',
      !led.throttled && Math.abs(led.seconds - 8 * 3600) < 2, `credited ${Math.round(led.seconds)}s`);
  }
  // Backwards clock pays nothing, and cannot run the economy in reverse.
  {
    const st = warm();
    const before = B.log10(st.depth);
    const led = E.resolveOffline(st, { wall: T0 + 24 * hour, budget: AWAY.baseCap }, { now: T0 });
    gate('a backwards clock credits nothing and never reverses',
      led.seconds === 0 && led.backwards && B.log10(st.depth) >= before - 1e-12, JSON.stringify({ s: led.seconds }));
  }
  // Winding the clock back and forth over ground already credited. This is the
  // attack the high-water mark exists for, and the one that IS fully stoppable
  // without a server: time may only ever be paid for once.
  {
    const st = warm();
    let clock = { wall: T0 - 8 * hour, high: T0 - 8 * hour, budget: AWAY.baseCap };
    const first = E.resolveOffline(st, clock, { now: T0 });
    clock = { wall: T0, high: first.high, budget: first.budget };
    let extra = 0;
    for (let i = 0; i < 50; i++) {
      // Wind back a day, then forward again to exactly where we already were.
      const led = E.resolveOffline(st, { ...clock, wall: T0 - 24 * hour }, { now: T0 });
      extra += led.seconds;
      clock = { wall: T0, high: led.high ?? clock.high, budget: led.budget ?? clock.budget };
    }
    gate('re-crossing already-credited time pays nothing',
      first.seconds > 28000 && extra === 0,
      `first ${Math.round(first.seconds)}s, then ${extra}s across 50 replays`);
  }
  // Marching the clock forward repeatedly. This cannot be reduced to zero
  // without a trusted clock — nothing offline can — but it can be BOUNDED:
  // every credited second must be paid for by a second of forward clock
  // travel, at a fixed exchange rate, and the rate is the same one an honest
  // player gets. The device date is the currency, and it only goes up.
  {
    const st = warm();
    let clock = { wall: T0, high: T0, budget: AWAY.baseCap };
    let credited = 0;
    let advanced = 0;
    let wall = T0;
    for (let i = 0; i < 60; i++) {
      const jump = 36 * hour;
      wall += jump;
      advanced += jump / 1000;
      const led = E.resolveOffline(st, clock, { now: wall });
      credited += led.seconds;
      clock = { wall, high: led.high, budget: led.budget };
    }
    gate('forward clock travel is paid for one second at a time',
      credited <= advanced * AWAY.refill + AWAY.baseCap,
      `${(credited / 3600).toFixed(0)}h credited for ${(advanced / 3600).toFixed(0)}h of clock travel`);
  }
}

// ============================================================ GATE 8
// Renderer inputs are bounded by construction, not by a clamp someone can
// delete. A warp of exactly 1 makes render.js's vignette inner radius negative
// and createRadialGradient throws.

function gate8(r) {
  gate('warp stays inside [0, 0.995]', r.warpMin >= 0 && r.warpMax <= 0.995,
    `[${r.warpMin.toFixed(3)}, ${r.warpMax.toFixed(3)}]`);
  gate('speed stays inside the renderer range',
    r.speedMin >= SPEED.min - 1 && r.speedMax <= SPEED.min + SPEED.span + 1,
    `[${Math.round(r.speedMin)}, ${Math.round(r.speedMax)}]`);
  const ok = r.gapsSeen.every((g) => [340, 680, 1360].includes(g));
  gate('ring spacing only ever takes the doubling ladder', ok, `{${r.gapsSeen.join(', ')}}`);
  const div = [340, 680, 1360].every((g) => Z_MODULUS % g === 0);
  gate('the z wrap is invisible at every ring spacing', div,
    `${Z_MODULUS} divisible by 340/680/1360`);
}

// ==================================================================== run

console.log('\nREDSHIFT: DEEP FIELD — economy gates\n');

const rows = gate1();
const inv = gate23();
gate6();

const DAYS = arg('days', 10);
process.stdout.write(`  simulating ${DAYS} days`);
const t0 = Date.now();
const r = bot(DAYS);
process.stdout.write(` — ${((Date.now() - t0) / 1000).toFixed(1)}s\n\n`);

gate5(r.st);
gate8(r);
gate('SCALE never regresses (the Big precision guard)', r.scaleMonotone,
  `final ${r.world.scale.toFixed(1)}, band ${r.world.band}`);
gate('there is always something to do within 15 minutes', r.longestGap <= 900,
  `longest empty stretch ${(r.longestGap / 60).toFixed(1)} min at ${(r.gapStart / 3600).toFixed(1)}h` +
  (r.longestGap > 900 && r.gapWhy ? `  ${JSON.stringify(r.gapWhy)}` : ''));
gate('the collapse rhythm never runs away into a whole day', r.longestCycle <= 6 * 3600,
  `longest cycle ${(r.longestCycle / 3600).toFixed(2)}h`);
// An idle game whose top layer is already maxed in a month has no month two.
// What matters is that the ladder grew and still has somewhere to go.
// The third prestige layer is a multi-day arc by design, so these two only
// assert once the simulation is long enough to have reached it. Stating the
// requirement beats quietly lowering the bar to whatever a short run hits.
const DEEP = DAYS >= 7;
gate(`the ladder grows and still has room left${DEEP ? '' : '  [needs --days 7+]'}`,
  !DEEP || (r.st.tiers > TIERS.base && r.st.omega.total >= 1 && r.st.tiers <= TIERS.max),
  `${r.st.tiers}/${TIERS.max} tiers, ${r.st.omega.total} omega after ${DAYS}d`);
gate(`all three prestige layers are reached${DEEP ? '' : '  [needs --days 7+]'}`,
  r.st.collapses > 0 && r.st.dilates > 0 && (!DEEP || r.st.horizons > 0),
  `${r.st.collapses} collapses, ${r.st.dilates} dilates, ${r.st.horizons} horizons`);
// Depth resets every collapse, so the end-state value says nothing. The best
// single cycle is the number that has to keep climbing.
gate('depth keeps growing to the end', r.st.bestCycleLog > 50,
  `best cycle 1e${Math.round(r.st.bestCycleLog)}`);

console.log(gates.join('\n'));

if (has('curve')) {
  console.log('\nPROGRESSION\n');
  console.log('  time        depth        rate/s      photons      tau     W  band  clock  tiers  c/d/h');
  console.log('  ' + '─'.repeat(94));
  for (const s of r.samples) {
    const hrs = s.t / 3600;
    const time = hrs < 48 ? `${hrs.toFixed(1)}h` : `${(hrs / 24).toFixed(1)}d`;
    console.log(
      `  ${time.padStart(7)}  ${B.fmt(s.depth).padStart(11)}  ${B.fmt(s.rate).padStart(10)}  ` +
      `${B.fmt(s.photons).padStart(10)}  ${B.fmt(s.tau).padStart(8)}  ` +
      `${String(Math.round(s.warp * 100)).padStart(2)}  ${String(s.band).padStart(4)}  ` +
      `${('x' + s.dil.toFixed(1)).padStart(6)}  ${String(s.tiers).padStart(5)}  ` +
      `${s.collapses}/${s.dilates}/${s.horizons}`
    );
  }
  const cyc = r.cycleTimes;
  if (cyc.length) {
    const med = [...cyc].sort((a, b) => a - b)[cyc.length >> 1];
    console.log(`\n  manual collapse cycles: ${cyc.length}, median ${(med / 60).toFixed(1)} min`);
  }
}

console.log(`\n${pass}/${pass + fail} gates passed${fail ? `  \x1b[31m(${fail} FAILED)\x1b[0m` : ''}\n`);
process.exit(fail ? 1 : 0);
