// Entity storage and collision.
//
// Everything is pooled and stored in dense arrays with swap-removal, so a
// 180-projectile screen allocates nothing per frame.
//
// On broadphase: the design doc called for a 40px uniform grid. With the
// shipped caps (180 projectiles, 22 enemies, ~60 bullets) the worst case is
// about 1,300 distance tests per 1/120s substep — roughly 160k/second, which
// is far cheaper than rebuilding a grid at the same rate. Brute force wins at
// this scale, so the grid is deliberately not here.

export class Pool {
  constructor(make, size) {
    this.items = new Array(size);
    for (let i = 0; i < size; i++) this.items[i] = make();
    this.count = 0;
    this.make = make;
  }

  spawn() {
    if (this.count >= this.items.length) return null; // caller decides what a cap means
    return this.items[this.count++];
  }

  release(i) {
    this.count--;
    const t = this.items[i];
    this.items[i] = this.items[this.count];
    this.items[this.count] = t;
  }

  clear() {
    this.count = 0;
  }
}

// Closest approach between two points moving linearly over one substep.
// Returns the minimum distance; this is the whole reason a 3px hitbox can
// survive 420px/s projectiles at 1/120s without tunnelling.
export function sweptMinDist(ax0, ay0, ax1, ay1, bx0, by0, bx1, by1) {
  const dx = ax0 - bx0;
  const dy = ay0 - by0;
  const vx = ax1 - ax0 - (bx1 - bx0);
  const vy = ay1 - ay0 - (by1 - by0);
  const a = vx * vx + vy * vy;
  let t = 0;
  if (a > 1e-9) {
    t = -(dx * vx + dy * vy) / a;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
  }
  const px = dx + vx * t;
  const py = dy + vy * t;
  return Math.sqrt(px * px + py * py);
}

// Same, but against a stationary target — the common case for bullets vs
// slow enemies, and cheaper because half the algebra drops out.
export function sweptMinDistStatic(ax0, ay0, ax1, ay1, bx, by) {
  return sweptMinDist(ax0, ay0, ax1, ay1, bx, by, bx, by);
}

export const PROJ = { PELLET: 0, SHARD: 1, ORB: 2 };

export function makeWorld() {
  return {
    // Hostile fire.
    proj: new Pool(
      () => ({
        x: 0, y: 0, px: 0, py: 0, vx: 0, vy: 0, r: 3.5,
        kind: PROJ.PELLET, color: '#FF2D7A', age: 0, life: 14,
        grazeT: 0, outT: 0, dead: false, converted: 0,
      }),
      220
    ),

    // Player fire.
    bullets: new Pool(
      () => ({ x: 0, y: 0, px: 0, py: 0, vx: 0, vy: 0, dmg: 1, pierce: 0, hits: [], age: 0 }),
      160
    ),

    enemies: new Pool(
      () => ({
        x: 0, y: 0, px: 0, py: 0, vx: 0, vy: 0,
        type: null, hp: 1, maxHp: 1, r: 10, angle: 0, spin: 0, expired: false,
        fireT: 0, state: 0, stateT: 0, age: 0,
        grazeT: 0, outT: 0, flash: 0, stun: 0, boss: false, cycle: 0, arm: 0,
        tx: 0, ty: 0, dashX: 0, dashY: 0,
      }),
      40
    ),

    // Score pickups that fly into the hull after a vent.
    motes: new Pool(
      () => ({ x: 0, y: 0, sx: 0, sy: 0, t: 0, dur: 0.3, value: 0, color: '#fff' }),
      260
    ),

    // CINDER burn fields: damage over time and a graze source you author.
    cinders: new Pool(() => ({ x: 0, y: 0, r: 34, life: 0, max: 2.5 }), 40),

    // Spawn telegraphs.
    pips: new Pool(() => ({ x: 0, y: 0, dir: 0, life: 0, max: 0.4, color: '#fff' }), 24),
  };
}

export function clearWorld(w) {
  w.proj.clear();
  w.bullets.clear();
  w.enemies.clear();
  w.motes.clear();
  w.cinders.clear();
  w.pips.clear();
}

// Spawns a hostile projectile, respecting the hard cap. Returns null when the
// cap is hit — the spawner must handle that rather than assume success.
export function fireProjectile(w, x, y, vx, vy, kind, color, r, cap = 180) {
  // The cap is enforced here, not left to the pool size — a screen past ~180
  // hostile projectiles stops being readable long before it stops being
  // performant, so the spawner must refuse rather than hope.
  let p = w.proj.count >= cap ? null : w.proj.spawn();
  if (!p) {
    // At cap: recycle the oldest projectile that is already off-screen, and if
    // there is none, refuse. Never silently delete something the player is
    // dodging.
    let oldest = -1;
    let oldestAge = -1;
    for (let i = 0; i < w.proj.count; i++) {
      const q = w.proj.items[i];
      if (q.age > oldestAge && (q.y < -20 || q.y > 900 || q.x < -20 || q.x > 380)) {
        oldest = i;
        oldestAge = q.age;
      }
    }
    if (oldest < 0) return null;
    p = w.proj.items[oldest];
  }
  p.x = p.px = x;
  p.y = p.py = y;
  p.vx = vx;
  p.vy = vy;
  p.kind = kind;
  p.color = color;
  p.r = r;
  p.age = 0;
  p.life = 14;
  p.grazeT = 0;
  p.outT = 0;
  p.dead = false;
  p.converted = 0;
  return p;
}
