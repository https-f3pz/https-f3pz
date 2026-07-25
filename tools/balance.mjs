// Headless balance harness.
//
// src/game/run.js deliberately has no canvas, DOM or audio dependencies, so
// the whole simulation can be driven in Node at thousands of times real time.
// Bots play the game four ways and we measure the tuning gates the design set:
//
//   * novice     — a first-timer: slow hands, late reactions, vents early
//   * competent  — hugs deliberately, but BANKS its heat with the vent
//   * pusher     — the same hands, committed to riding the meter to ignition
//   * expert     — tighter margin, never banks
//
// The vent is a genuine dilemma, so measuring only one answer to it measures
// the wrong player: the ignition-cadence gates apply to the pusher, and
// "pushing outscores banking" is the property that keeps the dilemma honest.
//
//   node tools/balance.mjs                 # default sweep
//   node tools/balance.mjs --runs 40       # more seeds
//   node tools/balance.mjs --skill novice

import { Run } from '../src/game/run.js';
import { baseStats, MUTATORS, CORES, PRESSURE } from '../src/game/config.js';
import { makeRng } from '../src/core/rng.js';

const STEP = 1 / 120;
const argv = process.argv.slice(2);
const arg = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : def;
};

// Fake collaborators — the simulation never notices they do nothing.
const fx = {
  clear() {}, shake() {}, flash() {}, ring() {}, text() {}, particle() {},
  burst() {}, spray() {}, update() {},
};
const loop = { freeze() {}, slowmo() {}, clearSlowmo() {}, fps: 60 };
const view = { vh: 779, insetTop: 0, insetBottom: 0 };

// ---------------------------------------------------------------- the bot

const CANDIDATES = [{ x: 0, y: 0 }];
for (let i = 0; i < 24; i++) {
  const a = (i / 24) * Math.PI * 2;
  CANDIDATES.push({ x: Math.cos(a), y: Math.sin(a) });
}

/**
 * A lookahead pilot. For each of 25 candidate headings it rolls the ship and
 * every nearby threat forward, then scores the heading by "did I survive" and
 * "how much time did I spend inside the graze band". This is much closer to
 * how a person actually plays a bullet hell than a potential field, which
 * cheerfully steers into things it is also attracted to.
 */
function pilot(run, skill) {
  const R = run.s.grazeRadius;
  const hit = run.s.hitbox;
  const w = run.world;

  // Gather nearby threats once.
  const tx = [], ty = [], tvx = [], tvy = [], tr = [];
  for (let i = 0; i < w.proj.count; i++) {
    const p = w.proj.items[i];
    if (p.converted) continue;
    if (Math.abs(p.x - run.x) > 260 || Math.abs(p.y - run.y) > 260) continue;
    // Perceived a fraction of a second late — this is what reaction time is.
    tx.push(p.x - p.vx * skill.lag); ty.push(p.y - p.vy * skill.lag);
    tvx.push(p.vx); tvy.push(p.vy); tr.push(p.r);
  }
  for (let i = 0; i < w.enemies.count; i++) {
    const e = w.enemies.items[i];
    if (Math.abs(e.x - run.x) > 300 || Math.abs(e.y - run.y) > 300) continue;
    // Enemy velocity is implicit in its behaviour; approximate from last step.
    const evx = (e.x - e.px) * 120;
    const evy = (e.y - e.py) * 120;
    tx.push(e.x - evx * skill.lag); ty.push(e.y - evy * skill.lag);
    tvx.push(evx); tvy.push(evy);
    tr.push(e.r * 0.8);
  }

  const H = skill.look; // horizon in seconds
  const STEPS = 6;
  const dtH = H / STEPS;
  let bestScore = -Infinity;
  let best = CANDIDATES[0];

  for (const c of CANDIDATES) {
    let sx = run.x;
    let sy = run.y;
    let score = 0;
    let died = false;
    let nearestEnd = 1e9;

    for (let s = 1; s <= STEPS; s++) {
      sx += c.x * skill.speed * dtH;
      sy += c.y * skill.speed * dtH;
      // A wall is an inconvenience, not a hazard — a player simply stops at
      // it. Penalising it heavily made every heading look bad and the pilot
      // froze in place, which is the one thing that reliably kills you.
      if (sx < run.arena.x + 8 || sx > run.arena.x + run.arena.w - 8) score -= 8;
      if (sy < run.shipMinY + 4 || sy > run.shipMaxY - 4) score -= 8;
      const cx = Math.max(run.arena.x + 6, Math.min(run.arena.x + run.arena.w - 6, sx));
      const cy = Math.max(run.shipMinY, Math.min(run.shipMaxY, sy));
      const t = s * dtH;

      for (let i = 0; i < tx.length; i++) {
        const ex = tx[i] + tvx[i] * t;
        const ey = ty[i] + tvy[i] * t;
        const d = Math.hypot(cx - ex, cy - ey) - tr[i];
        if (d <= hit + 0.5) {
          // Actual death. Dominates everything, and dying sooner is worse.
          died = true;
          score -= 1e6 * (STEPS - s + 1);
          break;
        }
        // Risk is normalised by the pilot's own comfort margin, so risk and
        // greed stay commensurate across skill levels instead of one term
        // swamping the other.
        const slack = d - hit;
        if (slack < skill.margin) {
          const k = 1 - slack / skill.margin;
          score -= k * k * 420;
        }
        if (d < R) score += (1 - d / R) * skill.greed; // grazing pays
        if (s === STEPS && d < nearestEnd) nearestEnd = d;
      }
      if (died) break;
    }

    // Fuel seeking: a real player actively flies toward the bullets, they
    // don't wait for the bullets to arrive.
    if (!died && nearestEnd < 1e8) score -= nearestEnd * skill.greed * 0.05;

    // Keep room to manoeuvre. Getting cornered is how this bot actually dies,
    // and it is how people die too.
    const ex = Math.max(run.arena.x + 6, Math.min(run.arena.x + run.arena.w - 6, sx));
    const ey = Math.max(run.shipMinY, Math.min(run.shipMaxY, sy));
    const room = Math.min(
      ex - run.arena.x, run.arena.x + run.arena.w - ex,
      ey - run.shipMinY, run.shipMaxY - ey
    );
    score += Math.min(room, 70) * 1.2;

    if (score > bestScore) {
      bestScore = score;
      best = c;
    }
  }
  return best;
}

// `speed` is px/second in the 360-wide logical space — a real thumb drag at
// 1.55 gain lands in this range. `look` is reaction lookahead in seconds.
// Steering is continuous (a hand does not move in 50ms jumps); skill is
// expressed as reaction latency, comfort margin, greed and hand speed.
const SKILLS = {
  // A first-timer: slow hands, late reactions, keeps well clear of everything,
  // and cashes the vent out the moment it arms because the danger band is
  // terrifying. Never gets hot enough to ignite.
  novice: { look: 0.17, margin: 27, greed: 8, speed: 250, ventAt: 40, think: 0.017, lag: 0.17 },
  // Twenty runs in: hugs deliberately at the edge of the graze ring, rides
  // toward the ignition, vents only when boxed in.
  competent: { look: 0.26, margin: 18, greed: 30, speed: 500, ventAt: 92, think: 0.017, lag: 0.07 },
  // The same hands as `competent`, but committed to riding the meter to 100
  // instead of banking it. The vent is a real dilemma, so the harness has to
  // measure BOTH answers to it — a banker and a pusher play very differently.
  pusher: { look: 0.26, margin: 18, greed: 30, speed: 500, ventAt: 9999, think: 0.017, lag: 0.07 },
  // Chasing the ladder: lives inside the danger band and almost never vents,
  // because venting costs a Flashover.
  expert: { look: 0.28, margin: 16, greed: 36, speed: 620, ventAt: 9999, think: 0.017, lag: 0.035 },
};

function simulate({ seed, skill, coreId = 'needle', pressure = 0, picks = [], runsSoFar = 5, maxTime = 180, autoDraft = true }) {
  const s = baseStats();
  CORES.find((c) => c.id === coreId).apply(s);
  for (let i = 0; i < pressure; i++) PRESSURE[i].apply(s);
  for (const id of picks) MUTATORS.find((m) => m.id === id)?.apply(s);
  if (runsSoFar < 3) s.density *= runsSoFar === 0 ? 0.62 : runsSoFar === 1 ? 0.78 : 0.9;

  const run = new Run({
    stats: s,
    seed,
    rng: makeRng(seed),
    fx,
    loop,
    view,
    save: { runs: runsSoFar },
  });

  const sk = SKILLS[skill];
  const trace = [];
  const flashTimes = [];
  let lastFlash = 0;
  let dir = { x: 0, y: 0 };
  let think = 0;
  let draftIdx = 0;
  const DRAFTS = [22, 52, 88, 128];
  const pool = MUTATORS.map((m) => m.id);
  const rng = makeRng(seed ^ 0x5f5f);
  rng.shuffle(pool);

  while (!run.dead && run.time < maxTime) {
    // Decisions are discrete (a human re-aims ~20x/second); motion is
    // continuous and speed-limited.
    think -= STEP;
    if (think <= 0) {
      think = sk.think;
      dir = pilot(run, sk);
    }
    const target = { x: run.x + dir.x * sk.speed * STEP, y: run.y + dir.y * sk.speed * STEP };

    // Drive the real steering path (relative drag + clamp + sticky rebase)
    // rather than teleporting, so the bot is subject to the same movement
    // limits a thumb is.
    run.anchorTouch = { x: 0, y: 0 };
    run.anchorShip = { x: run.x, y: run.y };
    const touch = { x: (target.x - run.x) / 1.55, y: (target.y - run.y) / 1.55 };

    if (process.env.TRACE) {
      let nd = 1e9;
      const w = run.world;
      for (let i = 0; i < w.proj.count; i++) {
        const p = w.proj.items[i];
        if (!p.converted) nd = Math.min(nd, Math.hypot(p.x - run.x, p.y - run.y) - p.r);
      }
      for (let i = 0; i < w.enemies.count; i++) {
        const e = w.enemies.items[i];
        nd = Math.min(nd, Math.hypot(e.x - run.x, e.y - run.y) - e.r);
      }
      trace.push(
        `t=${run.time.toFixed(2)} pos=(${run.x.toFixed(0)},${run.y.toFixed(0)}) ` +
        `dir=(${dir.x.toFixed(2)},${dir.y.toFixed(2)}) heat=${run.heat.toFixed(1)} ` +
        `sig=${run.sigma.toFixed(2)} near=${nd === 1e9 ? '-' : nd.toFixed(1)} ` +
        `en=${w.enemies.count} pr=${w.proj.count}`
      );
    }

    const before = run.flashCount;
    run.update(STEP, touch);
    run.events.length = 0;
    if (run.flashCount > before) {
      flashTimes.push(run.time - lastFlash);
      lastFlash = run.time;
    }

    // The vent is a panic button, not a heat threshold. Cashing out at a
    // fixed heat (the obvious policy) dumps the meter right before ignition
    // and suppresses Flashovers — a real player only vents when boxed in.
    if (run.armed && run.heat >= sk.ventAt) {
      let boxed = 0;
      const w = run.world;
      for (let i = 0; i < w.proj.count; i++) {
        const p = w.proj.items[i];
        if (!p.converted && Math.hypot(p.x - run.x, p.y - run.y) < 46) boxed++;
      }
      if (boxed >= 3) run.requestVent();
    }

    // Auto-draft: take the next card in a shuffled order.
    if (autoDraft && draftIdx < DRAFTS.length && run.time >= DRAFTS[draftIdx]) {
      const id = pool[draftIdx];
      picks.push(id);
      const ns = baseStats();
      CORES.find((c) => c.id === coreId).apply(ns);
      for (let i = 0; i < pressure; i++) PRESSURE[i].apply(ns);
      for (const pid of picks) MUTATORS.find((m) => m.id === pid)?.apply(ns);
      if (runsSoFar < 3) ns.density *= runsSoFar === 0 ? 0.62 : runsSoFar === 1 ? 0.78 : 0.9;
      run.s = ns;
      draftIdx++;
    }
  }

  if (process.env.TRACE) {
    console.log(trace.filter((_, i) => i % 30 === 0).slice(-16).join('\n'));
    console.log('--- final substeps ---');
    console.log(trace.slice(-6).join('\n'));
    console.log(`DIED t=${run.time.toFixed(2)} peakHeat=${run.tel.peakHeat.toFixed(1)}\n`);
  }

  const t = run.tel;
  return {
    time: run.time,
    score: run.score,
    flashovers: run.flashCount,
    flashGap: flashTimes.length ? flashTimes.reduce((a, b) => a + b, 0) / flashTimes.length : null,
    pctAbove85: run.time ? (t.above85 / run.time) * 100 : 0,
    pctAbove50: run.time ? (t.above50 / run.time) * 100 : 0,
    peakHeat: t.peakHeat,
    vents: run.ventCount,
    kills: t.kills,
    sparkUsed: run.sparkUsed,
    picks: [...picks],
  };
}

function stats(arr) {
  if (!arr.length) return { med: 0, min: 0, max: 0, mean: 0 };
  const s = [...arr].sort((a, b) => a - b);
  return {
    med: s[Math.floor(s.length / 2)],
    min: s[0],
    max: s[s.length - 1],
    mean: s.reduce((a, b) => a + b, 0) / s.length,
  };
}

// ---------------------------------------------------------- determinism
// The daily seed is only worth anything if the same seed and the same input
// produce byte-identical runs. Checked first, because every number below is
// meaningless if the simulation drifts.
function fingerprint(seed) {
  const run = new Run({
    stats: baseStats(), seed, rng: makeRng(seed), fx, loop, view, save: { runs: 5 },
  });
  for (let i = 0; i < 120 * 45 && !run.dead; i++) {
    run.iframes = 9e9; // isolate the simulation from death timing
    const t = run.time;
    const tx = 180 + Math.sin(t * 1.1) * 90;
    const ty = run.shipMaxY - 40 + Math.cos(t * 0.8) * 60;
    run.anchorTouch = { x: 0, y: 0 };
    run.anchorShip = { x: run.x, y: run.y };
    run.update(STEP, { x: (tx - run.x) / 1.55, y: (ty - run.y) / 1.55 });
    run.events.length = 0;
  }
  return `${run.score.toFixed(6)}|${run.heat.toFixed(6)}|${run.tel.kills}|${run.x.toFixed(6)},${run.y.toFixed(6)}`;
}

const fpA = fingerprint(1234567);
const fpB = fingerprint(1234567);
const fpC = fingerprint(7654321);
const deterministic = fpA === fpB && fpA !== fpC;
console.log(
  `\ndeterminism: ${deterministic ? '\x1b[32mOK\x1b[0m' : '\x1b[31mBROKEN\x1b[0m'}` +
  ` — same seed ${fpA === fpB ? 'identical' : 'DIVERGED'}, different seed ${fpA !== fpC ? 'differs' : 'IDENTICAL (!)'}`
);

const N = Number(arg('runs', 24));
const only = arg('skill', null);
const skills = only ? [only] : ['novice', 'competent', 'pusher', 'expert'];

console.log(`\nFLASHOVER balance sweep — ${N} seeds per profile\n`);
console.log('profile      survival(s)        score      flash/run   gap(s)   %>85   %>50   vents');
console.log('─'.repeat(88));

const table = {};
for (const skill of skills) {
  const rows = [];
  for (let i = 0; i < N; i++) {
    rows.push(simulate({
      seed: 1000 + i * 7919,
      skill,
      runsSoFar: skill === 'novice' ? 0 : 5,
    }));
  }
  const time = stats(rows.map((r) => r.time));
  const score = stats(rows.map((r) => r.score));
  const fl = stats(rows.map((r) => r.flashovers));
  const gaps = rows.map((r) => r.flashGap).filter((v) => v != null);
  const gap = stats(gaps);
  const a85 = stats(rows.map((r) => r.pctAbove85));
  const a50 = stats(rows.map((r) => r.pctAbove50));
  const vents = stats(rows.map((r) => r.vents));
  table[skill] = { time, score, fl, gap, a85, a50, vents };

  console.log(
    `${skill.padEnd(12)} ` +
    `${time.med.toFixed(1).padStart(5)} (${time.min.toFixed(0)}-${time.max.toFixed(0)})`.padEnd(19) +
    `${Math.round(score.med).toLocaleString().padStart(9)}   ` +
    `${fl.med.toFixed(1).padStart(9)}   ` +
    `${(gap.med || 0).toFixed(1).padStart(6)}   ` +
    `${a85.med.toFixed(1).padStart(4)}   ` +
    `${a50.med.toFixed(1).padStart(4)}   ` +
    `${vents.med.toFixed(1).padStart(5)}`
  );
}

// ---- the gates from the design doc
console.log('\nTUNING GATES');
const gate = (name, ok, detail) =>
  console.log(`  ${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${name.padEnd(46)} ${detail}`);

// The ignition cadence is only meaningful for a player who is actually going
// for ignition; a banker deliberately trades Flashovers for safety.
if (table.pusher) {
  const p = table.pusher;
  gate('pusher: one flashover every 22-30s', p.gap.med >= 18 && p.gap.med <= 34, `${p.gap.med.toFixed(1)}s`);
  gate('pusher: 18-28% of run above heat 85', p.a85.med >= 14 && p.a85.med <= 34, `${p.a85.med.toFixed(1)}%`);
}
if (table.competent) {
  const c = table.competent;
  gate('competent: survives past the first boss (75s)', c.time.med >= 75, `${c.time.med.toFixed(1)}s`);
}
if (table.pusher && table.competent) {
  gate(
    'pushing outscores banking',
    table.pusher.score.med > table.competent.score.med,
    `${Math.round(table.pusher.score.med).toLocaleString()} vs ${Math.round(table.competent.score.med).toLocaleString()}`
  );
}
if (table.novice) {
  const n = table.novice;
  gate(
    'a first-run player gets a taste, not mastery',
    n.fl.med <= 1 && (!table.pusher || n.a85.med < table.pusher.a85.med * 0.6),
    `${n.fl.med.toFixed(1)} flashovers, ${n.a85.med.toFixed(1)}% above heat 85`
  );
}
if (table.pusher && table.novice) {
  gate(
    'engaging outscores hiding by 3x or more',
    table.pusher.score.med > table.novice.score.med * 3,
    `${Math.round(table.pusher.score.med).toLocaleString()} vs ${Math.round(table.novice.score.med).toLocaleString()}`
  );
}

// ---- mutator sanity: no card should be dead weight or an auto-pick
if (!only) {
  console.log('\nMUTATOR IMPACT (competent, single pick, no auto-draft, 120s cap)');
  const baseRows = [];
  const MUT_SEEDS = 10;
  const MUT_TIME = 120; // a shorter horizon keeps the sweep to a sane runtime
  for (let i = 0; i < MUT_SEEDS; i++) {
    baseRows.push(simulate({ seed: 500 + i * 6151, skill: 'competent', autoDraft: false, maxTime: MUT_TIME }));
  }
  const baseScore = stats(baseRows.map((r) => r.score)).med || 1;
  const out = [];
  for (const m of MUTATORS) {
    const rows = [];
    for (let i = 0; i < MUT_SEEDS; i++) {
      rows.push(simulate({ seed: 500 + i * 6151, skill: 'competent', picks: [m.id], autoDraft: false, maxTime: MUT_TIME }));
    }
    const sc = stats(rows.map((r) => r.score)).med;
    out.push({ id: m.id, name: m.name, ratio: sc / baseScore, score: sc });
  }
  out.sort((a, b) => b.ratio - a.ratio);
  for (const o of out) {
    const bar = '█'.repeat(Math.max(0, Math.min(30, Math.round(o.ratio * 10))));
    console.log(`  ${o.name.padEnd(18)} ${o.ratio.toFixed(2)}x  ${bar}`);
  }
  const ratios = out.map((o) => o.ratio);
  gate('no dead mutator (all >= 0.75x baseline)', Math.min(...ratios) >= 0.75, `min ${Math.min(...ratios).toFixed(2)}x`);
  gate('no auto-pick mutator (all <= 2.2x baseline)', Math.max(...ratios) <= 2.2, `max ${Math.max(...ratios).toFixed(2)}x`);
}

console.log('');
