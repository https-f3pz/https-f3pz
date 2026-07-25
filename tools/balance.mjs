// Headless flight harness.
//
// src/game/run.js has no canvas, DOM or audio dependency, so the whole
// simulation runs in Node at thousands of times real time.
//
// Bots differ in ONE thing: how close to the wall they choose to fly. That is
// the entire skill of REDSHIFT — the centre of the gap is safe and slow, the
// edge of the gap is fast and lethal — so a harness that separates pilots by
// aim is measuring the actual game.
//
//   node tools/balance.mjs
//   node tools/balance.mjs --runs 30
//   node tools/balance.mjs --curve        # speed/warp vs distance, one pilot

import { Run } from '../src/game/run.js';
import { SPEED, SHIP, GRAZE, WARP, zoneAt, speedFloor } from '../src/game/config.js';
import { arcsAt, clearance } from '../src/game/track.js';
import { makeRng } from '../src/core/rng.js';

const STEP = 1 / 120;
const TAU = Math.PI * 2;
const argv = process.argv.slice(2);
const arg = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : d;
};
const has = (n) => argv.includes(`--${n}`);

const loop = { freeze() {}, slowmo() {}, clearSlowmo() {}, fps: 60 };
const view = { vh: 1558, insetTop: 0, insetBottom: 0 };
const save = { best: 0, upgrades: { grip: 0, lens: 0, intake: 0, hull: 0 } };

// A pilot is two decisions. `attempt` is how often it goes for a graze at all
// (otherwise it takes the middle of the widest opening); `target` is where in
// the graze band it aims when it does, as a fraction of GRAZE.angle — low
// means shaving the wall itself. `jitter` is hand tremor in radians, without
// which a bot is inhumanly precise and the reckless line looks free.
//
// This is deliberately NOT an interpolation between "centre" and "edge": the
// graze band is a fixed width whatever the gap, so a pilot aiming 80% of the
// way to the edge of a wide opening still misses it entirely. Real players
// commit to an edge or they don't.
const PILOTS = {
  timid: { attempt: 0.0, target: 0.60, jitter: 0.04 },
  steady: { attempt: 0.65, target: 0.62, jitter: 0.05 },
  greedy: { attempt: 1.0, target: 0.22, jitter: 0.07 },
  // Control: never steers at all. If this one travels a long way, the track is
  // not asking anything of the player.
  passive: { attempt: 0, target: 0, jitter: 0, never: true },
};

// The widest opening in a plane, found by sampling clearance around the bore.
// Sampling (rather than interval algebra) means it reads exactly the same
// geometry the collision test does, so the bot can never aim at a gap the
// simulation does not agree exists.
const SAMPLES = 192;
function widest(plane, t, buf) {
  const arcs = arcsAt(plane, t, buf);
  let bestA = 0;
  let bestC = -Infinity;
  for (let i = 0; i < SAMPLES; i++) {
    const a = (i / SAMPLES) * TAU;
    const c = clearance(a, arcs);
    if (c > bestC) {
      bestC = c;
      bestA = a;
    }
  }
  return { angle: bestA, half: bestC };
}

function fly(seed, sk, opts = {}) {
  const maxDist = opts.maxDist ?? 400000;
  const run = new Run({ seed, save, loop, view });
  const rng = makeRng((seed ^ 0x9e3779b9) >>> 0);
  const buf = [];
  const samples = [];
  let touch = { x: 0 };
  let steps = 0;
  let nextSample = 0;
  let sumWarp = 0;
  let sumExcess = 0;
  let peakWarp = 0;
  // Which edge of the gap this pilot is shaving, and its hand tremor, decided
  // ONCE per plane. Re-rolling these every frame makes the target flip sides
  // 120 times a second, so the ship chases the average — the centre — and the
  // whole aim axis the harness is built to measure quietly disappears.
  let committed = null;
  let side = 1;
  let tremor = 0;
  let going = false;

  while (!run.dead && run.dist < maxDist && steps < 120 * 600) {
    steps++;

    if (!sk.never) {
      // Commit to the nearest plane ahead and HOLD that aim until it is crossed.
      // Releasing early to line up the next one drifts the ship off the gap it
      // is still inside, which reads as a clip the pilot never chose.
      let target = null;
      let bestDz = Infinity;
      for (const p of run.track.planes()) {
        const dz = p.z - run.z;
        if (dz > 0 && dz < bestDz) {
          bestDz = dz;
          target = p;
        }
      }
      if (target) {
        if (target !== committed) {
          committed = target;
          side = rng.chance(0.5) ? 1 : -1;
          tremor = rng.range(-sk.jitter, sk.jitter);
          going = rng.chance(sk.attempt);
        }
        const w = widest(target, run.z / 1000, buf);
        // Aim for a chosen *clearance*, not a chosen angle, so the same pilot
        // shaves a wide opening and a narrow one the same way. `widest`
        // reports raw clearance to the arc, so the hull's own width has to be
        // added back on — aiming at the bare graze window would be aiming a
        // third of a radian inside the wall.
        const desiredC = going ? SHIP.radius + GRAZE.angle * sk.target : w.half;
        const desired = w.angle + Math.max(0, w.half - desiredC) * side + tremor;

        // Drive the real drag-steering path, so turn rate and the sticky
        // anchor rebase apply exactly as they do under a thumb.
        if (run.anchorTouch == null) touch = { x: 0 };
        else {
          const d = Math.atan2(Math.sin(desired - run.anchorAngle), Math.cos(desired - run.anchorAngle));
          touch = { x: run.anchorTouch + d / SHIP.dragGain };
        }
      }
    }

    run.update(STEP, sk.never ? null : touch);
    run.events.length = 0;

    sumWarp += run.warp;
    // Speed ABOVE the floor is the only part a pilot earns. Raw top speed
    // flatters whoever survived longest, because the floor itself rises with
    // distance — comparing pilots on it measures endurance, not flying.
    sumExcess += run.speed - speedFloor(run.dist);
    if (run.warp > peakWarp) peakWarp = run.warp;
    if (opts.curve && run.dist >= nextSample) {
      samples.push({ dist: run.dist, speed: run.speed, warp: run.warp, zone: run.zone.name, clips: run.clips });
      nextSample += 20000;
    }
  }

  return {
    dist: run.dist,
    time: steps * STEP,
    score: run.score,
    speed: run.speed,
    top: run.topSpeed,
    meanWarp: sumWarp / Math.max(1, steps),
    excess: sumExcess / Math.max(1, steps),
    peakWarp,
    grazes: run.grazes,
    gates: run.gates,
    combo: run.bestCombo,
    clips: run.clips,
    cause: run.dead ? run.deathCause : run.dist >= maxDist ? 'capped' : 'timeout',
    samples,
  };
}

const med = (a) => {
  const s = [...a].sort((x, y) => x - y);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
};

// ------------------------------------------------------------ determinism
// The daily seed is only meaningful offline if the same seed replays exactly.
function fingerprint(seed) {
  const r = fly(seed, PILOTS.steady, { maxDist: 9000 });
  return `${r.dist.toFixed(4)}|${r.gates}|${r.grazes}|${r.clips}|${r.cause}`;
}
const fpA = fingerprint(4242);
const fpB = fingerprint(4242);
const fpC = fingerprint(9999);
console.log(
  `\ndeterminism: ${fpA === fpB && fpA !== fpC ? '\x1b[32mOK\x1b[0m' : '\x1b[31mBROKEN\x1b[0m'}` +
  ` — same seed ${fpA === fpB ? 'identical' : 'DIVERGED'}, different seed ${fpA !== fpC ? 'differs' : 'IDENTICAL (!)'}`
);

// ------------------------------------------------------- the warp curve
// The premise of the game is that velocity visibly distorts the view. If warp
// does not climb across a run, there is no game — so print it explicitly.
if (has('curve')) {
  const r = fly(777, PILOTS.steady, { curve: true, maxDist: 400000 });
  console.log('\nWARP CURVE — steady pilot, seed 777\n');
  console.log('  dist     speed   warp   fov     zone            clips');
  console.log('  ' + '─'.repeat(60));
  for (const s of r.samples) {
    const fov = Math.round(WARP.fovMin + (WARP.fovMax - WARP.fovMin) * s.warp);
    const bar = '█'.repeat(Math.round(s.warp * 24)).padEnd(24, '·');
    console.log(
      `  ${String(Math.round(s.dist)).padStart(6)}  ${String(Math.round(s.speed)).padStart(6)}  ` +
      `${String(Math.round(s.warp * 100)).padStart(3)}%  ${String(fov).padStart(5)}   ${s.zone.padEnd(14)}  ${String(s.clips).padStart(3)}  ${bar}`
    );
  }
  console.log(`\n  ended: ${r.cause} at ${Math.round(r.dist)} — peak warp ${Math.round(r.peakWarp * 100)}%\n`);
  process.exit(0);
}

// ------------------------------------------------------------- the sweep
const N = Number(arg('runs', 20));
console.log(`\nREDSHIFT flight sweep — ${N} seeds per pilot\n`);
console.log('pilot        dist      time(s)   earned spd   warp mean/peak   score     graze   clips/10k   died to');
console.log('─'.repeat(104));

const table = {};
for (const name of ['passive', 'timid', 'steady', 'greedy']) {
  const rows = [];
  for (let i = 0; i < N; i++) rows.push(fly(1000 + i * 7919, PILOTS[name]));
  const causes = {};
  for (const r of rows) causes[r.cause] = (causes[r.cause] || 0) + 1;
  const top = Object.entries(causes).sort((a, b) => b[1] - a[1])[0];
  table[name] = {
    dist: med(rows.map((r) => r.dist)),
    time: med(rows.map((r) => r.time)),
    top: med(rows.map((r) => r.top)),
    meanWarp: med(rows.map((r) => r.meanWarp)),
    excess: med(rows.map((r) => r.excess)),
    peakWarp: med(rows.map((r) => r.peakWarp)),
    grazes: med(rows.map((r) => r.grazes)),
    combo: med(rows.map((r) => r.combo)),
    clips: med(rows.map((r) => r.clips)),
    score: med(rows.map((r) => r.score)),
    causes,
  };
  const t = table[name];
  t.clipRate = (t.clips / Math.max(1, t.dist)) * 10000;
  console.log(
    `${name.padEnd(12)} ${Math.round(t.dist).toLocaleString().padStart(7)}  ${t.time.toFixed(1).padStart(9)}   ` +
    `${('+' + Math.round(t.excess)).padStart(10)}   ${(Math.round(t.meanWarp * 100) + '%/' + Math.round(t.peakWarp * 100) + '%').padStart(13)}   ` +
    `${Math.round(t.score).toLocaleString().padStart(7)}   ${String(t.grazes).padStart(5)}   ${t.clipRate.toFixed(2).padStart(9)}   ${top[0]} (${top[1]}/${N})`
  );
}

console.log('\nGATES');
const gate = (name, ok, detail) =>
  console.log(`  ${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${name.padEnd(54)} ${detail}`);

// The premise gate. Everything else is secondary to this one.
gate('the view actually distorts (steady peaks past 55% warp)',
  table.steady.peakWarp > 0.55,
  `mean ${Math.round(table.steady.meanWarp * 100)}%, peak ${Math.round(table.steady.peakWarp * 100)}%`);
gate('a calm run is legible early (mean warp under 60%)',
  table.timid.meanWarp < 0.60,
  `timid mean ${Math.round(table.timid.meanWarp * 100)}%`);
// Compared against TIMID, not GREEDY: a reckless pilot spends so much time
// knocked below the floor by clips that its earned speed goes negative, and a
// ratio between two negative numbers passes for the wrong reason.
gate('grazing is what buys speed',
  table.steady.excess > table.timid.excess + 250,
  `steady ${Math.round(table.steady.excess)} over the floor vs timid ${Math.round(table.timid.excess)}`);
gate('greed is punished as well as rewarded',
  table.greedy.clipRate > table.timid.clipRate * 1.5,
  `greedy ${table.greedy.clipRate.toFixed(2)} clips/10k vs timid ${table.timid.clipRate.toFixed(2)}`);
gate('flying fast beats playing safe (distance)',
  table.steady.dist > table.timid.dist,
  `steady ${Math.round(table.steady.dist)} vs timid ${Math.round(table.timid.dist)}`);
gate('...and beats it on score too',
  table.steady.score > table.timid.score,
  `steady ${Math.round(table.steady.score).toLocaleString()} vs timid ${Math.round(table.timid.score).toLocaleString()}`);
gate('doing nothing gets you nowhere',
  table.passive.dist < table.steady.dist * 0.5,
  `passive ${Math.round(table.passive.dist)} vs steady ${Math.round(table.steady.dist)}`);
gate('nobody flies forever',
  ['timid', 'steady', 'greedy'].every((k) => (table[k].causes.timeout ?? 0) === 0),
  Object.entries(table).map(([k, v]) => `${k}:${Object.keys(v.causes).join('/')}`).join('  '));
// One-thumb reflex games live at well under two minutes — Super Hexagon calls
// 60s a win. This is the band for the genre, not a number picked to pass.
gate('a run lasts 30-120s',
  table.steady.time >= 30 && table.steady.time <= 120,
  `steady ${table.steady.time.toFixed(1)}s, timid ${table.timid.time.toFixed(1)}s`);
gate('the speed ceiling holds',
  table.greedy.top <= SPEED.max + 1,
  `${Math.round(table.greedy.top)} <= ${SPEED.max}`);

console.log('');
