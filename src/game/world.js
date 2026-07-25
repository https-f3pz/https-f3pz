// The chasm.
//
// Everything is a pure function of (seed, depth): the shaft walls are closed
// form, and the contents are generated per 900px chunk from a seeded RNG keyed
// by chunk index. Nothing depends on what happened above, so chunks can be
// dropped the moment they leave the camera and regenerated identically if the
// player somehow returns.

import { VW, CHUNK, PX_PER_M, HAZ, halfGap, centreX } from './config.js';
import { makeRng } from '../core/rng.js';

// Pattern table. `from` is the depth in metres at which a pattern enters the
// pool — the shaft teaches itself one idea at a time.
const PATTERNS = [
  { id: 'open', from: 0, weight: 3, lateWeight: 1 },
  { id: 'sawgate', from: 220, weight: 3 },
  { id: 'spikes', from: 450, weight: 2 },
  { id: 'crushers', from: 800, weight: 3 },
  { id: 'orbit', from: 1300, weight: 3 },
  { id: 'pinch', from: 2000, weight: 2 },
  { id: 'zigzag', from: 3200, weight: 3 },
  { id: 'gauntlet', from: 5200, weight: 2 },
];

function makeHazard(type, x, y, o = {}) {
  return {
    type, x, y,
    r: o.r ?? 34,
    w: o.w ?? 0,
    h: o.h ?? 0,
    amp: o.amp ?? 0,
    freq: o.freq ?? 1,
    phase: o.phase ?? 0,
    spin: o.spin ?? 3,
    orbitR: o.orbitR ?? 0,
    orbitSpeed: o.orbitSpeed ?? 1,
    side: o.side ?? 1,
    // Live position, refreshed each substep by stepHazard().
    cx: x, cy: y, pcx: x, pcy: y,
  };
}

// Hazards move on a clock, not on state, so rewinding or regenerating a chunk
// can never desynchronise them.
export function stepHazard(h, t) {
  h.pcx = h.cx;
  h.pcy = h.cy;
  if (h.type === HAZ.CRUSHER) {
    h.cx = h.x + Math.sin(t * h.freq * Math.PI * 2 + h.phase) * h.amp * h.side;
    h.cy = h.y;
  } else if (h.type === HAZ.ORBIT) {
    const a = t * h.orbitSpeed + h.phase;
    h.cx = h.x + Math.cos(a) * h.orbitR;
    h.cy = h.y + Math.sin(a) * h.orbitR;
  } else {
    h.cx = h.x;
    h.cy = h.y;
  }
}

function addAnchors(out, rng, y0, y1, spacing) {
  for (let y = y0 + rng.range(60, 200); y < y1; y += spacing * rng.range(0.8, 1.25)) {
    const c = centreX(y);
    const g = halfGap(y);
    const side = rng.chance(0.5) ? -1 : 1;
    // Anchors sit well inside the shaft so a swing has room to develop.
    out.anchors.push({ x: c + side * g * rng.range(0.30, 0.72), y, seen: 0 });
    if (rng.chance(0.28)) {
      out.anchors.push({ x: c - side * g * rng.range(0.30, 0.62), y: y + rng.range(90, 200), seen: 0 });
    }
  }
}

export function generateChunk(seed, index) {
  const rng = makeRng((seed ^ (index * 2654435761)) >>> 0);
  const y0 = index * CHUNK;
  const y1 = y0 + CHUNK;
  const metres = y0 / PX_PER_M;
  const out = { index, y0, y1, anchors: [], hazards: [], gems: [] };

  // Difficulty rides depth, not time, so a fast diver meets it sooner.
  const d = Math.min(1.4, metres / 9000);
  const speed = 1 + d * 0.7;

  const pool = PATTERNS.filter((p) => metres >= p.from);
  const pattern = index === 0 ? PATTERNS[0]
    : rng.weighted(pool, (p) => (metres > 1200 && p.lateWeight != null ? p.lateWeight : p.weight));

  addAnchors(out, rng, y0, y1, pattern.id === 'open' ? 420 : 330);

  const mid = (y) => centreX(y);
  const gap = (y) => halfGap(y);

  switch (pattern.id) {
    case 'open': {
      // A breather, and the only place raw terminal velocity pays off.
      for (let i = 0; i < 2; i++) {
        const y = y0 + rng.range(120, CHUNK - 120);
        out.gems.push({ x: mid(y) + rng.range(-1, 1) * gap(y) * 0.7, y, taken: false });
      }
      break;
    }
    case 'sawgate': {
      const n = 1 + (rng.chance(0.45) ? 1 : 0);
      for (let i = 0; i < n; i++) {
        const y = y0 + 200 + i * 420 + rng.range(-60, 60);
        const c = mid(y);
        const g = gap(y);
        // Blocks the CENTRE and leaves the lanes at the edges: the gate has to
        // be a reason to steer, and the middle is where gravity already takes
        // you for free.
        const bias = rng.range(-0.22, 0.22) * g;
        out.hazards.push(makeHazard(HAZ.SAW, c + bias, y, { r: 52 + d * 14, spin: 4 * speed }));
        if (rng.chance(0.5)) {
          out.hazards.push(makeHazard(HAZ.SAW, c + bias + (rng.sign() * g * 0.62), y + rng.range(-40, 40), {
            r: 40 + d * 10, spin: -4 * speed,
          }));
        }
        // The gem sits in the lane you have to swing into.
        out.gems.push({ x: c + bias - Math.sign(bias || 1) * g * 0.66, y: y + 8, taken: false });
      }
      break;
    }
    case 'spikes': {
      const side = rng.chance(0.5) ? -1 : 1;
      const top = y0 + rng.range(120, 320);
      const h = rng.range(300, 520);
      for (let y = top; y < top + h; y += 78) {
        const c = mid(y);
        const g = gap(y);
        out.hazards.push(makeHazard(HAZ.SPIKE, c + side * (g - 24), y, { w: 54, h: 74, side }));
      }
      // A blocker on the open side, so the lane is genuinely narrow rather
      // than "hug the far wall and stop thinking".
      if (d > 0.25) {
        const my = top + h * 0.5;
        out.hazards.push(makeHazard(HAZ.SAW, mid(my) - side * gap(my) * 0.18, my, { r: 40, spin: 4 * speed }));
      }
      // Reward hugging the opposite wall.
      out.gems.push({ x: mid(top + h / 2) - side * gap(top + h / 2) * 0.72, y: top + h / 2, taken: false });
      break;
    }
    case 'crushers': {
      const n = 2 + (d > 0.6 ? 1 : 0);
      for (let i = 0; i < n; i++) {
        const y = y0 + 160 + i * 300 + rng.range(-50, 50);
        const c = mid(y);
        const g = gap(y);
        const side = i % 2 === 0 ? -1 : 1;
        out.hazards.push(makeHazard(HAZ.CRUSHER, c + side * (g - 60), y, {
          w: 150, h: 66, amp: g * 0.62, freq: (0.28 + rng.range(0, 0.16)) * speed,
          phase: rng.angle(), side: -side,
        }));
      }
      break;
    }
    case 'orbit': {
      // A saw orbiting an anchor: the best hook in the chunk is inside danger.
      const n = 1 + (rng.chance(0.4) ? 1 : 0);
      for (let i = 0; i < n; i++) {
        const y = y0 + 220 + i * 440;
        const c = mid(y);
        const g = gap(y);
        const ax = c + rng.range(-0.4, 0.4) * g;
        out.anchors.push({ x: ax, y, seen: 0, risky: true });
        out.hazards.push(makeHazard(HAZ.ORBIT, ax, y, {
          r: 30 + d * 8, orbitR: 132, orbitSpeed: (1.5 + rng.range(0, 0.7)) * speed, phase: rng.angle(),
        }));
        out.gems.push({ x: ax, y: y + 2, taken: false });
      }
      break;
    }
    case 'pinch': {
      const y = y0 + 380;
      const c = mid(y);
      const g = gap(y);
      out.hazards.push(makeHazard(HAZ.SPIKE, c - g + 20, y, { w: 60, h: 120, side: -1 }));
      out.hazards.push(makeHazard(HAZ.SPIKE, c + g - 20, y, { w: 60, h: 120, side: 1 }));
      out.hazards.push(makeHazard(HAZ.SAW, c, y + 300, { r: 46 + d * 14, spin: 5 * speed }));
      out.gems.push({ x: c - g * 0.55, y: y + 300, taken: false });
      out.gems.push({ x: c + g * 0.55, y: y + 300, taken: false });
      break;
    }
    case 'zigzag': {
      for (let i = 0; i < 3; i++) {
        const y = y0 + 130 + i * 250;
        const c = mid(y);
        const g = gap(y);
        const side = i % 2 === 0 ? -1 : 1;
        out.hazards.push(makeHazard(HAZ.CRUSHER, c + side * (g - 50), y, {
          w: 168, h: 58, amp: g * 0.75, freq: (0.34 + i * 0.05) * speed, phase: i * 1.9, side: -side,
        }));
        out.gems.push({ x: c - side * g * 0.6, y: y + 120, taken: false });
      }
      break;
    }
    case 'gauntlet': {
      const y = y0 + 200;
      const c = mid(y);
      const g = gap(y);
      out.hazards.push(makeHazard(HAZ.SAW, c - g * 0.55, y, { r: 42, spin: 6 * speed }));
      out.hazards.push(makeHazard(HAZ.SAW, c + g * 0.55, y + 190, { r: 42, spin: -6 * speed }));
      out.hazards.push(makeHazard(HAZ.CRUSHER, c - (g - 50), y + 420, {
        w: 170, h: 60, amp: g * 0.8, freq: 0.42 * speed, phase: rng.angle(), side: 1,
      }));
      for (let yy = y + 560; yy < y1 - 40; yy += 78) {
        out.hazards.push(makeHazard(HAZ.SPIKE, mid(yy) + (gap(yy) - 24), yy, { w: 54, h: 74, side: 1 }));
      }
      out.gems.push({ x: c, y: y + 95, taken: false });
      out.gems.push({ x: c - g * 0.6, y: y + 640, taken: false });
      break;
    }
    default:
      break;
  }

  for (const h of out.hazards) stepHazard(h, 0);
  return out;
}

/**
 * A sliding window of live chunks. Only what the camera can reach is kept, and
 * because generation is deterministic nothing is lost by dropping the rest.
 */
export class World {
  constructor(seed) {
    this.seed = seed >>> 0;
    this.chunks = new Map();
  }

  ensure(fromY, toY) {
    const a = Math.max(0, Math.floor(fromY / CHUNK));
    const b = Math.floor(toY / CHUNK) + 1;
    for (let i = a; i <= b; i++) {
      if (!this.chunks.has(i)) this.chunks.set(i, generateChunk(this.seed, i));
    }
    // Drop anything comfortably behind the camera.
    for (const key of this.chunks.keys()) {
      if (key < a - 1 || key > b + 1) this.chunks.delete(key);
    }
  }

  *live() {
    for (const c of this.chunks.values()) yield c;
  }

  step(t) {
    for (const c of this.chunks.values()) {
      for (const h of c.hazards) stepHazard(h, t);
    }
  }
}

// --------------------------------------------------------------- collision

// Closest distance from a moving point's path to a static point. The diver
// covers up to 35px per substep at full speed, so every hazard test has to be
// swept or thin geometry is simply missed.
export function segPointDist(ax, ay, bx, by, px, py) {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 1e-9 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const qx = ax + dx * t - px;
  const qy = ay + dy * t - py;
  return Math.hypot(qx, qy);
}

// Swept point against a moving circle: solve in the circle's frame.
export function sweptCircleHit(ax, ay, bx, by, c, r) {
  return segPointDist(ax - (c.pcx - c.cx), ay - (c.pcy - c.cy), bx, by, c.cx, c.cy) <= r;
}

// Segment vs axis-aligned box (slab method), inflated by the diver's radius.
export function segBoxHit(ax, ay, bx, by, cx, cy, hw, hh, pad = 0) {
  const minX = cx - hw - pad;
  const maxX = cx + hw + pad;
  const minY = cy - hh - pad;
  const maxY = cy + hh + pad;
  let t0 = 0;
  let t1 = 1;
  const dx = bx - ax;
  const dy = by - ay;
  for (let axis = 0; axis < 2; axis++) {
    const p = axis === 0 ? dx : dy;
    const o = axis === 0 ? ax : ay;
    const lo = axis === 0 ? minX : minY;
    const hi = axis === 0 ? maxX : maxY;
    if (Math.abs(p) < 1e-9) {
      if (o < lo || o > hi) return false;
    } else {
      let ta = (lo - o) / p;
      let tb = (hi - o) / p;
      if (ta > tb) {
        const tmp = ta;
        ta = tb;
        tb = tmp;
      }
      if (ta > t0) t0 = ta;
      if (tb < t1) t1 = tb;
      if (t0 > t1) return false;
    }
  }
  return true;
}
