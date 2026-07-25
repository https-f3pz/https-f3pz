// Headless dive harness.
//
// src/game/run.js has no canvas, DOM or audio dependency, so the whole
// simulation runs in Node at thousands of times real time. Bots fly it with
// different *release timing* — which is the entire skill of the game — and the
// harness checks that timing actually separates them.
//
//   node tools/balance.mjs
//   node tools/balance.mjs --runs 30

import { Run } from '../src/game/run.js';
import { PHYS, PX_PER_M, HAZ, halfGap, centreX } from '../src/game/config.js';
import { makeRng } from '../src/core/rng.js';

const STEP = 1 / 120;
const argv = process.argv.slice(2);
const arg = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : d;
};

const loop = { freeze() {}, slowmo() {}, clearSlowmo() {}, fps: 60 };
const view = { vh: 1558, insetTop: 0, insetBottom: 0 };
const save = { best: 0, upgrades: { reach: 0, snap: 0, winch: 0, wax: 0 } };

// A pendulum releases into a direction that depends entirely on WHERE in the
// arc you let go. Bottom-dead-centre (the anchor directly above you) sends you
// sideways; letting go before it sends you down and out. `lead` is how many
// radians before bottom-dead-centre the pilot releases — the one number that
// separates a beginner from an expert.
// `refire` is how long the pilot free-falls between swings. It matters more
// than anything else: gravity is what makes depth, and every moment on the
// rope is a moment not falling. A pilot that re-hooks instantly never dives.
const PILOTS = {
  // Never lets go of anything, hangs past the bottom of every arc, and gets
  // carried sideways while the Collapse eats the gap.
  novice: { lead: -0.45, maxHold: 2.2, refire: 0.55, reel: false, look: 520 },
  // Swings to steer, then falls. Releases just before bottom-dead-centre.
  competent: { lead: 0.28, maxHold: 0.85, refire: 0.12, reel: false, look: 1150 },
  // Short committed arcs, releases early, reels at the bottom to pump speed.
  expert: { lead: 0.52, maxHold: 0.55, refire: 0.08, reel: true, look: 1500 },
  // Control: never touches the rope at all. If this one does well the Collapse
  // is not applying real pressure; if it dies fast the shaft is unfair.
  freefall: { lead: 0, maxHold: 0, refire: 1e9, reel: false, never: true, look: 0 },
};

// The widest gap a diver could pass through at this depth, and where its
// centre is. This is the target a real player is steering for, so the bot
// should steer for it too — hooking on a timer is not a model of play.
const DIVER = 11;
function lane(run, y) {
  const left = centreX(y) - halfGap(y) + DIVER;
  const right = centreX(y) + halfGap(y) - DIVER;
  const spans = [];
  for (const chunk of run.world.live()) {
    if (chunk.y1 < y - 200 || chunk.y0 > y + 200) continue;
    for (const h of chunk.hazards) {
      const half = h.type === HAZ.SAW || h.type === HAZ.ORBIT ? h.r : Math.max(h.w, h.h) / 2;
      const vert = h.type === HAZ.SAW || h.type === HAZ.ORBIT ? h.r : h.h / 2;
      if (Math.abs(h.cy - y) > vert + 120) continue;
      spans.push([h.cx - half - DIVER - 30, h.cx + half + DIVER + 30]);
    }
  }
  spans.sort((a, b) => a[0] - b[0]);
  let best = 0;
  let bestMid = (left + right) / 2;
  let cursor = left;
  for (const [a, b] of spans) {
    if (a - cursor > best) {
      best = a - cursor;
      bestMid = (cursor + a) / 2;
    }
    cursor = Math.max(cursor, b);
  }
  if (right - cursor > best) {
    best = right - cursor;
    bestMid = (cursor + right) / 2;
  }
  return bestMid;
}

function fly(seed, sk, maxTime = 240) {
  const run = new Run({ seed, save, loop, view });
  let sinceRelease = 0;

  while (!run.dead && run.time < maxTime) {
    sinceRelease += STEP;

    // Steer for the centre of the widest lane a screen or so ahead. The rope
    // is the only steering there is, so hooking is purposeful: hook the side
    // that swings you toward the lane, release when you are moving at it.
    const wantX = sk.never ? run.x : lane(run, run.y + sk.look);
    const err = wantX - run.x;

    if (!sk.never && run.hook === 0 && sinceRelease > sk.refire && Math.abs(err) > 70) {
      run.selectTarget(err > 0 ? 700 : 20);
      if (run.target && Math.sign(run.target.x - run.x) === Math.sign(err)) {
        run.fire(err > 0 ? 700 : 20);
        sinceRelease = 0;
      } else {
        sinceRelease = sk.refire * 0.5;
      }
    } else if (run.hook === 2) {
      const a = run.anchor;
      const dx = run.x - a.x;
      const dy = run.y - a.y;
      const ang = Math.atan2(dy, dx);
      const spin = Math.sign(dx * run.vy - dy * run.vx) || 1;
      const target = Math.PI / 2 - sk.lead * spin;
      const diff = Math.atan2(Math.sin(ang - target), Math.cos(ang - target));
      // Let go once the swing is actually carrying us at the lane, or at the
      // pilot's release point, or if we have simply hung on too long.
      const movingRight = run.vx > 120;
      const movingLeft = run.vx < -120;
      const heading = (err > 0 && movingRight) || (err < 0 && movingLeft);
      if ((heading && Math.abs(err) < 120) || Math.abs(diff) < 0.10 || run.ropeAge > sk.maxHold) {
        run.release();
        sinceRelease = 0;
      }
    }

    // Reeling conserves angular momentum, but only pays at the bottom of the
    // arc — so the expert reels there and nowhere else.
    let touch = null;
    if (sk.reel && run.hook === 2 && run.anchor) {
      const a = run.anchor;
      const ang = Math.atan2(run.y - a.y, run.x - a.x);
      if (Math.abs(Math.atan2(Math.sin(ang - Math.PI / 2), Math.cos(ang - Math.PI / 2))) < 0.5) {
        touch = { x: 360, y: 0, startY: 200 };
      }
    }

    run.update(STEP, touch);
    run.events.length = 0;
  }
  return {
    depth: run.depth,
    time: run.time,
    score: run.score,
    top: run.topSpeedSeen ?? 0,
    whips: run.whipcracks,
    combo: run.bestCombo,
    gems: run.gems,
    cause: run.dead ? run.deathCause : 'timeout',
  };
}

// run.js does not track top speed itself (the game layer does), so measure it
// here by wrapping update.
const origUpdate = Run.prototype.update;
Run.prototype.update = function patched(dt, touch) {
  origUpdate.call(this, dt, touch);
  const sp = Math.hypot(this.vx, this.vy);
  if (sp > (this.topSpeedSeen ?? 0)) this.topSpeedSeen = sp;
};

const med = (a) => {
  const s = [...a].sort((x, y) => x - y);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
};

// ------------------------------------------------------------ determinism
function fingerprint(seed) {
  const r = fly(seed, PILOTS.competent, 40);
  return `${r.depth.toFixed(4)}|${r.time.toFixed(4)}|${r.whips}|${r.cause}`;
}
const fpA = fingerprint(4242);
const fpB = fingerprint(4242);
const fpC = fingerprint(9999);
console.log(
  `\ndeterminism: ${fpA === fpB && fpA !== fpC ? '\x1b[32mOK\x1b[0m' : '\x1b[31mBROKEN\x1b[0m'}` +
  ` — same seed ${fpA === fpB ? 'identical' : 'DIVERGED'}, different seed ${fpA !== fpC ? 'differs' : 'IDENTICAL (!)'}`
);

const N = Number(arg('runs', 20));
console.log(`\nHOOKFALL dive sweep — ${N} seeds per pilot\n`);
console.log('pilot        depth(m)          time(s)   top px/s   whips   chain   died to');
console.log('─'.repeat(80));

const table = {};
for (const name of ['freefall', 'novice', 'competent', 'expert']) {
  const rows = [];
  for (let i = 0; i < N; i++) rows.push(fly(1000 + i * 7919, PILOTS[name]));
  const causes = {};
  for (const r of rows) causes[r.cause] = (causes[r.cause] || 0) + 1;
  const top = Object.entries(causes).sort((a, b) => b[1] - a[1])[0];
  table[name] = {
    depth: med(rows.map((r) => r.depth)),
    time: med(rows.map((r) => r.time)),
    top: med(rows.map((r) => r.top)),
    whips: med(rows.map((r) => r.whips)),
    combo: med(rows.map((r) => r.combo)),
    causes,
  };
  const t = table[name];
  console.log(
    `${name.padEnd(12)} ${Math.round(t.depth).toLocaleString().padStart(8)}  ` +
    `${t.time.toFixed(1).padStart(14)}   ${Math.round(t.top).toString().padStart(8)}   ` +
    `${String(t.whips).padStart(5)}   ${String(t.combo).padStart(5)}   ${top[0]} (${top[1]}/${N})`
  );
}

console.log('\nGATES');
console.log('  \x1b[2m(the pilots below are crude: they steer for the widest lane but do not');
console.log('   plan a swing. Treat depth as a LOWER bound on what a human manages.)\x1b[0m');
const gate = (name, ok, detail) =>
  console.log(`  ${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${name.padEnd(52)} ${detail}`);

gate(
  'the rope beats pure free-fall',
  Math.max(table.novice.depth, table.competent.depth, table.expert.depth) > table.freefall.depth,
  `best pilot ${Math.round(Math.max(table.novice.depth, table.competent.depth, table.expert.depth))} m vs freefall ${Math.round(table.freefall.depth)} m`
);
// KNOWN OPEN: the design target is a 60-180s dive. The bots manage ~6s, and
// the shaft has been measured as genuinely navigable (mean clear lane ~450px,
// never impassable), so most of that gap is pilot quality — but not provably
// all of it. This gate is deliberately left failing rather than moved to a
// number the harness happens to hit.
gate('a competent dive lasts 45-200s  [OPEN]', table.competent.time >= 45 && table.competent.time <= 200,
  `${table.competent.time.toFixed(1)}s — needs hands-on tuning, see README`);
gate('a pure free-fall still dies (the rope is not optional)',
  (table.freefall.causes.timeout ?? 0) === 0 && table.freefall.depth < table.competent.depth,
  `freefall ${Math.round(table.freefall.depth)} m via ${Object.keys(table.freefall.causes).join('/')}`);
gate('nobody survives forever (the Collapse always wins)',
  ['novice', 'competent', 'expert'].every((k) => (table[k].causes.timeout ?? 0) === 0),
  Object.entries(table).map(([k, v]) => `${k}:${Object.keys(v.causes).join('/')}`).join('  '));
gate('reeling breaks past terminal velocity (1900 px/s)', table.expert.top > 1900,
  `expert top ${Math.round(table.expert.top)} px/s`);
gate('the speed cap holds', table.expert.top <= PHYS.maxSpeed + 1,
  `${Math.round(table.expert.top)} <= ${PHYS.maxSpeed}`);
gate('hazards, not walls, are what kill you',
  (table.competent.causes.hazard ?? 0) > 0,
  Object.entries(table.competent.causes).map(([k, v]) => `${k}:${v}`).join(' '));

console.log('');
