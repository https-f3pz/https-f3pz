// The track.
//
// An endless tube of obstacles, generated one CHUNK at a time from a seeded
// RNG keyed by chunk index. Everything is a pure function of (seed, z), so
// chunks are dropped the moment they pass the camera and would regenerate
// identically — which is what lets the daily seed mean something offline.
//
// Every obstacle is expressed as a set of BLOCKED ANGULAR ARCS at a given z.
// Collision is therefore "is my angle inside a blocked arc as I cross its z",
// which is exact, cheap, and — importantly — independent of how wildly the
// renderer is distorting the view at the time.

import { CHUNK, OBS, TUBE, speedFloor } from './config.js';
import { makeRng } from '../core/rng.js';

const TAU = Math.PI * 2;

const PATTERNS = [
  { id: 'gap', from: 0, weight: 4 },
  { id: 'twin', from: 12000, weight: 3 },
  { id: 'comb', from: 35000, weight: 3 },
  { id: 'spinner', from: 65000, weight: 3 },
  { id: 'iris', from: 100000, weight: 2 },
  { id: 'weave', from: 150000, weight: 3 },
];

/**
 * One obstacle plane. `arcs` are [centre, halfWidth] pairs in radians; the
 * ship dies if its angle falls inside one when it crosses `z`. `spin` rotates
 * the whole set over time, and `irisT` shrinks the single open arc.
 */
function plane(z, arcs, o = {}) {
  return {
    z,
    arcs,
    spin: o.spin ?? 0,
    phase: o.phase ?? 0,
    kind: o.kind ?? OBS.WALLS,
    iris: o.iris ?? 0,
    passed: false,
    grazed: false,
  };
}

// Blocked arcs at time t, written into a reusable buffer to keep the hot path
// allocation-free.
export function arcsAt(p, t, out) {
  out.length = 0;
  const rot = p.spin * t + p.phase;
  for (let i = 0; i < p.arcs.length; i++) {
    const a = p.arcs[i];
    let half = a[1];
    if (p.iris) {
      // An iris closes as you approach: the gap you saw is not the gap you get.
      half = Math.min(Math.PI * 0.94, half + p.iris);
    }
    out.push(a[0] + rot, half);
  }
  return out;
}

// A ring of `sides` sectors with `open` of them left clear.
function sectorArcs(sides, openIdx) {
  const step = TAU / sides;
  const arcs = [];
  for (let i = 0; i < sides; i++) {
    if (openIdx.includes(i)) continue;
    arcs.push([i * step + step / 2, step / 2]);
  }
  return arcs;
}

export function generateChunk(seed, index) {
  const rng = makeRng((seed ^ (index * 2654435761)) >>> 0);
  const z0 = index * CHUNK;
  const dist = z0;
  const out = { index, z0, z1: z0 + CHUNK, planes: [] };

  const d = Math.min(1.3, dist / 120000);
  const sides = TUBE.sides;
  const pool = PATTERNS.filter((p) => dist >= p.from);
  const pat = index === 0 ? PATTERNS[0] : rng.weighted(pool, (p) => p.weight);

  // Spacing is measured in SECONDS, not units. The bore pulls you faster and
  // faster, so a fixed unit spacing would quietly turn into an unreadable
  // strobe; scaling by the speed the floor implies at this depth keeps planes
  // arriving at a rate a thumb can answer, and lets the escalating speed show
  // up as spectacle rather than as an unfair difficulty curve.
  const interval = 0.55 - 0.25 * Math.min(1, dist / 120000);
  const spacing = Math.max(320, speedFloor(z0) * interval);

  // Openings WALK around the bore rather than teleporting across it. At this
  // spacing the ship can turn about 3 rad between planes, and the bore is only
  // 3.14 rad from side to side — so a uniformly random opening is sometimes
  // physically out of reach, which is not difficulty, it is a coin flip.
  const maxHop = dist < 100000 ? 3 : 2;
  let cur = rng.int(0, sides - 1);
  const cur0 = cur;
  const hop = () => {
    cur = (cur + rng.int(-maxHop, maxHop) + sides) % sides;
    return cur;
  };

  switch (pat.id) {
    case 'gap': {
      // The clean introduction to "rotate to the hole". Two sectors wide while
      // you are learning, one once you are deep — the hull is 0.32 rad across,
      // so that single sector is a genuinely tight fit.
      const wide = dist < 60000;
      for (let z = z0 + 200; z < out.z1; z += spacing * rng.range(1.0, 1.5)) {
        const a = hop();
        out.planes.push(plane(z, sectorArcs(sides, wide ? [a, (a + 1) % sides] : [a])));
      }
      break;
    }
    case 'twin': {
      // Two openings: a choice, and therefore a route.
      for (let z = z0 + 200; z < out.z1; z += spacing * rng.range(1.1, 1.6)) {
        const a = hop();
        const b = (a + rng.int(2, sides - 2)) % sides;
        out.planes.push(plane(z, sectorArcs(sides, [a, b])));
      }
      break;
    }
    case 'comb': {
      // Alternating teeth — you must weave, not just park in one lane.
      let flip = rng.chance(0.5);
      for (let z = z0 + 200; z < out.z1; z += spacing * 0.8) {
        const open = [];
        for (let i = 0; i < sides; i++) if ((i % 2 === 0) === flip) open.push(i);
        out.planes.push(plane(z, sectorArcs(sides, open), { kind: OBS.COMB }));
        flip = !flip;
      }
      break;
    }
    case 'spinner': {
      // The whole plane rotates, so the gap moves while you are aiming at it.
      for (let z = z0 + 240; z < out.z1; z += spacing * rng.range(1.2, 1.7)) {
        // One two-sector opening. Drawing two independent indices could pick
        // the same one twice, leaving a single narrow hole on a plane that is
        // also rotating — which is not a challenge, it is a coin flip.
        const a = hop();
        out.planes.push(plane(z, sectorArcs(sides, [a, (a + 1) % sides]), {
          kind: OBS.SPINNER,
          spin: rng.sign() * (0.5 + d * 0.7) * rng.range(0.8, 1.3),
          phase: rng.angle(),
        }));
      }
      break;
    }
    case 'iris': {
      // A single wide opening that narrows the closer you get.
      for (let z = z0 + 300; z < out.z1; z += spacing * rng.range(1.5, 2.0)) {
        const openIdx = hop();
        out.planes.push(plane(z, sectorArcs(sides, [openIdx, (openIdx + 1) % sides]), {
          kind: OBS.IRIS,
          // Closes from both sides, so this eats twice its value out of a
          // two-sector opening. Any more and it shuts below the hull's width.
          iris: 0.10 + d * 0.08,
        }));
      }
      break;
    }
    case 'weave': {
      // Openings that walk one sector at a time: a continuous rotation, which
      // at speed is the most demanding thing in the game.
      for (let z = z0 + 200; z < out.z1; z += spacing * 0.85) {
        cur = (cur + (rng.chance(0.5) ? 1 : sides - 1)) % sides;
        out.planes.push(plane(z, sectorArcs(sides, [cur]), {
          kind: OBS.SPINNER,
          spin: rng.sign() * d * 0.35,
          phase: rng.angle(),
        }));
      }
      break;
    }
    default:
      break;
  }

  out.planes.sort((a, b) => a.z - b.z);

  // The chunk seam is the one place the generator is blind: the previous chunk
  // picked its openings from its own seed, so the walk above cannot bound the
  // jump into this one. Widening the first plane to a three-sector mouth keeps
  // that seam passable from anywhere on the bore, and doubles as a visible
  // beat when the pattern changes.
  if (out.planes.length) {
    const p0 = out.planes[0];
    p0.arcs = sectorArcs(sides, [cur0, (cur0 + 1) % sides, (cur0 + 2) % sides]);
    p0.iris = 0;
    p0.spin = 0;
  }
  return out;
}

/** Sliding window of live chunks; behind the camera is dropped immediately. */
export class Track {
  constructor(seed) {
    this.seed = seed >>> 0;
    this.chunks = new Map();
  }

  ensure(fromZ, toZ) {
    const a = Math.max(0, Math.floor(fromZ / CHUNK));
    const b = Math.floor(toZ / CHUNK) + 1;
    for (let i = a; i <= b; i++) {
      if (!this.chunks.has(i)) this.chunks.set(i, generateChunk(this.seed, i));
    }
    for (const k of this.chunks.keys()) if (k < a - 1 || k > b + 1) this.chunks.delete(k);
  }

  *planes() {
    for (const c of this.chunks.values()) {
      for (const p of c.planes) yield p;
    }
  }
}

// Shortest signed angular difference, in (-PI, PI].
export function angleDiff(a, b) {
  return Math.atan2(Math.sin(a - b), Math.cos(a - b));
}

/**
 * How far (in radians) the ship is from the nearest blocked arc: negative
 * means inside it. Used for both the kill test and the near-miss test, so the
 * two can never disagree about what "close" means.
 */
export function clearance(angle, arcs) {
  let best = Infinity;
  for (let i = 0; i < arcs.length; i += 2) {
    const gap = Math.abs(angleDiff(angle, arcs[i])) - arcs[i + 1];
    if (gap < best) best = gap;
  }
  return best;
}
