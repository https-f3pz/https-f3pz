// One dive.
//
// Gravity is always giving you momentum and the Collapse is always taking away
// your margin, so the run accelerates on its own and conservative play is not
// an option. The only verb is the rope.
//
// Simulated at a fixed 1/120s substep. Nothing here touches the canvas.

import {
  VW, PX_PER_M, PHYS, COLLAPSE, GRAZE, HAZ,
  halfGap, centreX, biomeAt, upgradeValue,
} from './config.js';
import { World, segPointDist, sweptCircleHit, segBoxHit } from './world.js';
import { clamp } from '../core/draw.js';
import { buzz } from '../core/input.js';

const DIVER_R = 11;

export class Run {
  constructor({ seed, save, loop, view, daily = false }) {
    this.seed = seed >>> 0;
    this.save = save;
    this.loop = loop;
    this.daily = daily;
    this.world = new World(this.seed);

    this.layout(view);

    // Upgrades change how the rope behaves, never how far you can get.
    this.hookRange = upgradeValue(save, 'reach');
    this.snapBoost = upgradeValue(save, 'snap');
    this.reelRate = upgradeValue(save, 'winch');
    this.dragHooked = upgradeValue(save, 'wax');

    this.x = centreX(0);
    this.y = 120;
    this.px = this.x;
    this.py = this.y;
    this.vx = 0;
    this.vy = 320;

    // Rope: 0 idle, 1 in flight, 2 attached
    this.hook = 0;
    this.anchor = null;
    this.L = 0;
    this.hx = 0;
    this.hy = 0;
    this.ropeAge = 0;
    this.whipT = 0;

    this.target = null; // auto-selected anchor, always visible
    this.arc = []; // predicted swing, recomputed per frame

    this.time = 0;
    this.depth = 0; // metres, max reached
    this.score = 0;
    this.shards = 0;
    this.gems = 0;
    this.combo = 0;
    this.comboT = 0;
    this.bestCombo = 0;
    this.whipcracks = 0;
    this.reeled = false;
    this.dead = false;
    this.deathCause = '';

    this.collapseY = this.y - COLLAPSE.startGap;
    this.milestone = 0;
    this.biome = biomeAt(0);

    this.bestKnown = save?.best ?? 0;
    this.passedBest = (save?.best ?? 0) <= 0;

    this.trail = [];
    this.trailT = 0;

    this.events = [];
    this.world.ensure(this.y - 2000, this.y + 4000);
  }

  layout(view) {
    this.view = view;
    this.vh = view.vh;
  }

  emit(type, a, b) {
    this.events.push({ type, a, b });
  }

  get speed() {
    return Math.hypot(this.vx, this.vy);
  }

  get mult() {
    return 1 + GRAZE.multPer * Math.min(this.combo, GRAZE.maxCombo);
  }

  get metres() {
    return this.y / PX_PER_M;
  }

  // ------------------------------------------------------------ the rope

  fire(thumbX) {
    if (this.dead || this.hook !== 0) return;
    const a = this.target;
    if (!a) {
      this.emit('whiff');
      return;
    }
    this.hook = 1;
    this.anchor = a;
    this.hx = this.x;
    this.hy = this.y;
    this.emit('fire');
  }

  release() {
    if (this.hook === 0) return;
    const wasAttached = this.hook === 2;
    this.hook = 0;
    this.anchor = null;
    if (!wasAttached) return;

    const sp = this.speed;
    // Releasing with real tangential speed pays. This is the entire skill of
    // the game expressed as one multiplier, and it teaches itself by feel.
    if (sp > PHYS.snapSpeed) {
      const k = Math.min(this.snapBoost, PHYS.maxSpeed / Math.max(1, sp));
      this.vx *= k;
      this.vy *= k;
    }
    if (sp > PHYS.whipSpeed) {
      this.whipcracks++;
      this.whipT = 0.14;
      this.score += 500 * this.mult;
      this.loop.freeze(0.09);
      this.emit('whip', this.x, this.y);
      buzz(18);
    } else {
      this.emit('release');
    }
  }

  // ---------------------------------------------------------------- update

  update(dt, touch) {
    if (this.dead) {
      this.deathT = (this.deathT ?? 0) + dt;
      return;
    }

    this.px = this.x;
    this.py = this.y;
    this.time += dt;

    this.stepHook(dt);
    this.integrate(dt, touch);
    this.constrain(dt, touch);
    this.walls();
    this.world.ensure(this.y - 1600, this.y + 3600);
    this.world.step(this.time);
    this.hazards();
    this.pickups();
    this.grazes(dt);
    this.collapse(dt);
    this.progress(dt);
  }

  stepHook(dt) {
    if (this.hook !== 1) return;
    const a = this.anchor;
    const dx = a.x - this.hx;
    const dy = a.y - this.hy;
    const d = Math.hypot(dx, dy);
    const step = PHYS.hookSpeed * dt;
    if (d <= step) {
      this.hx = a.x;
      this.hy = a.y;
      this.hook = 2;
      this.L = clamp(Math.hypot(this.x - a.x, this.y - a.y), PHYS.ropeMin, PHYS.ropeMax);
      this.ropeAge = 0;
      this.emit('attach', a.x, a.y);
      buzz(10);
    } else {
      this.hx += (dx / d) * step;
      this.hy += (dy / d) * step;
    }
  }

  integrate(dt, touch) {
    const k = this.hook === 2 ? this.dragHooked : PHYS.dragFree;
    this.vy += PHYS.gravity * dt;
    const sp = Math.hypot(this.vx, this.vy);
    if (sp > 0) {
      const drag = k * sp * dt;
      this.vx -= this.vx * drag;
      this.vy -= this.vy * drag;
    }
    const cap = PHYS.maxSpeed;
    const s2 = Math.hypot(this.vx, this.vy);
    if (s2 > cap) {
      this.vx = (this.vx / s2) * cap;
      this.vy = (this.vy / s2) * cap;
    }
    this.x += this.vx * dt;
    this.y += this.vy * dt;
  }

  constrain(dt, touch) {
    if (this.hook !== 2) return;
    const a = this.anchor;
    this.ropeAge += dt;

    // Reel: slide the same thumb up to shorten the rope. Optional, and the
    // game never requires it — but conserving angular momentum means a reel at
    // the bottom of an arc is a genuine speed pump.
    if (touch && touch.startY != null) {
      const slide = touch.y - touch.startY;
      if (Math.abs(slide) > PHYS.reelDeadzone) {
        const dir = slide < 0 ? -1 : 1;
        const before = this.L;
        this.L = clamp(this.L + dir * this.reelRate * dt, PHYS.reelMin, PHYS.reelMax);
        if (dir < 0) this.reeled = true;
        if (this.L !== before) this.pump(a, before, this.L);
      }
    }

    let dx = this.x - a.x;
    let dy = this.y - a.y;
    let d = Math.hypot(dx, dy);
    if (d <= this.L || d < 1e-6) return; // one-sided: slack rope does nothing

    const nx = dx / d;
    const ny = dy / d;
    this.x = a.x + nx * this.L;
    this.y = a.y + ny * this.L;
    const vn = this.vx * nx + this.vy * ny;
    if (vn > 0) {
      this.vx -= nx * vn;
      this.vy -= ny * vn;
      // Whatever is left is purely tangential; feed part of the radial speed
      // the constraint just ate back into it, in the direction already
      // travelling. This is what turns the rope into a steering tool.
      const tx = -ny;
      const ty = nx;
      let vt = this.vx * tx + this.vy * ty;
      const dir = vt >= 0 ? 1 : -1;
      vt += dir * vn * PHYS.swingConvert;
      const capped = clamp(vt, -PHYS.maxSpeed, PHYS.maxSpeed);
      this.vx = tx * capped;
      this.vy = ty * capped;
    }
  }

  // Angular momentum: shortening the rope by half doubles tangential speed.
  // Capped, or a player can reel-spin into infinity and break the curve.
  pump(a, rOld, rNew) {
    if (rNew >= rOld) return;
    const dx = this.x - a.x;
    const dy = this.y - a.y;
    const d = Math.hypot(dx, dy) || 1;
    if (d < rOld - 2) return; // only pays while the rope is actually taut
    const nx = dx / d;
    const ny = dy / d;
    const tx = -ny;
    const ty = nx;
    let vt = this.vx * tx + this.vy * ty;
    vt *= rOld / rNew;
    const capped = clamp(vt, -PHYS.maxSpeed, PHYS.maxSpeed);
    this.vx = tx * capped;
    this.vy = ty * capped;
  }

  // Walls are solid but survivable: a clip costs most of your speed, and the
  // Collapse does the punishing. Lethal walls in a 300px shaft at 4200 px/s
  // would make this a memorisation game.
  walls() {
    const g = halfGap(this.y);
    const c = centreX(this.y);
    const left = c - g + DIVER_R;
    const right = c + g - DIVER_R;
    let hit = 0;
    if (this.x < left) {
      this.x = left;
      if (this.vx < 0) this.vx = -this.vx * PHYS.wallBounce;
      hit = -1;
    } else if (this.x > right) {
      this.x = right;
      if (this.vx > 0) this.vx = -this.vx * PHYS.wallBounce;
      hit = 1;
    }
    if (hit) {
      const sp = this.speed;
      if (sp > 500) {
        this.vy *= PHYS.wallScrape;
        this.breakCombo();
        this.emit('scrape', this.x, this.y);
      }
    }
  }

  hazards() {
    const ax = this.px;
    const ay = this.py;
    const bx = this.x;
    const by = this.y;
    for (const chunk of this.world.live()) {
      if (chunk.y1 < ay - 400 || chunk.y0 > by + 400) continue;
      for (const h of chunk.hazards) {
        let hit = false;
        if (h.type === HAZ.SAW || h.type === HAZ.ORBIT) {
          hit = sweptCircleHit(ax, ay, bx, by, h, h.r + DIVER_R);
        } else if (h.type === HAZ.CRUSHER) {
          hit = segBoxHit(ax, ay, bx, by, h.cx, h.cy, h.w / 2, h.h / 2, DIVER_R);
        } else if (h.type === HAZ.SPIKE) {
          hit = segBoxHit(ax, ay, bx, by, h.cx, h.cy, h.w / 2, h.h / 2, DIVER_R * 0.6);
        }
        if (hit) {
          this.die('hazard');
          return;
        }
      }
    }
  }

  pickups() {
    for (const chunk of this.world.live()) {
      if (chunk.y1 < this.py - 200 || chunk.y0 > this.y + 200) continue;
      for (const g of chunk.gems) {
        if (g.taken) continue;
        if (segPointDist(this.px, this.py, this.x, this.y, g.x, g.y) < 42) {
          g.taken = true;
          this.gems++;
          const v = 250 * this.mult;
          this.score += v;
          this.shards += 8;
          this.loop.freeze(0.04);
          this.emit('gem', g.x, g.y);
        }
      }
    }
  }

  grazes(dt) {
    if (this.comboT > 0) {
      this.comboT -= dt;
      if (this.comboT <= 0 && this.combo > 0) {
        this.emit('comboEnd', this.combo);
        this.combo = 0;
      }
    }
    const sp = this.speed;
    if (sp < GRAZE.minSpeed) return;

    const addGraze = (x, y) => {
      this.combo++;
      if (this.combo > this.bestCombo) this.bestCombo = this.combo;
      this.comboT = GRAZE.window;
      this.score += GRAZE.points * this.combo;
      this.shards += 1;
      this.emit('graze', x, y);
    };

    // Near-misses on hazards.
    for (const chunk of this.world.live()) {
      if (chunk.y1 < this.py - 300 || chunk.y0 > this.y + 300) continue;
      for (const h of chunk.hazards) {
        const surf = h.type === HAZ.CRUSHER || h.type === HAZ.SPIKE
          ? Math.max(h.w, h.h) / 2
          : h.r;
        const d = segPointDist(this.px, this.py, this.x, this.y, h.cx, h.cy) - surf - DIVER_R;
        if (d < GRAZE.radius && d > -2) {
          if ((h.grazeT ?? 0) <= 0) {
            h.grazeT = 0.5;
            addGraze(h.cx, h.cy);
          }
        }
        if (h.grazeT > 0) h.grazeT -= dt;
      }
    }

    // Skimming a wall counts too — it rewards the tight line and makes long
    // chains reachable without a hazard on every screen.
    const g = halfGap(this.y);
    const c = centreX(this.y);
    const dl = this.x - (c - g);
    const dr = c + g - this.x;
    const near = Math.min(dl, dr) - DIVER_R;
    if (near < GRAZE.radius && near > 1) {
      this.wallGrazeT = (this.wallGrazeT ?? 0) - dt;
      if (this.wallGrazeT <= 0) {
        this.wallGrazeT = 0.34;
        addGraze(dl < dr ? c - g : c + g, this.y);
      }
    }
  }

  breakCombo() {
    if (this.combo > 0) {
      this.emit('comboEnd', this.combo);
      this.combo = 0;
      this.comboT = 0;
    }
  }

  collapse(dt) {
    const speed = COLLAPSE.baseSpeed + COLLAPSE.accel * this.time;
    this.collapseY += speed * dt;
    // Never let it fall so far behind that it stops being a threat.
    const lag = this.y - this.collapseY;
    if (lag > COLLAPSE.maxLag) this.collapseY = this.y - COLLAPSE.maxLag;
    if (this.collapseY >= this.y) this.die('collapse');
  }

  progress(dt) {
    const m = this.metres;
    if (m > this.depth) {
      // Points accrue per metre, multiplied by the chain — so flying close is
      // not a side quest, it is the scoring system.
      this.score += (m - this.depth) * 10 * this.mult;
      this.shards += (m - this.depth) / 200;
      this.depth = m;
    }

    const nextStone = (this.milestone + 1) * 1000;
    if (m >= nextStone) {
      this.milestone++;
      this.emit('milestone', this.milestone * 1000);
    }

    const b = biomeAt(m);
    if (b !== this.biome) {
      this.biome = b;
      this.emit('biome', b.name);
    }

    if (!this.passedBest && m > this.bestKnown) {
      this.passedBest = true;
      this.emit('best');
    }
  }

  die(cause) {
    if (this.dead || this.god) return; // `god` is set only by tools/shots.mjs
    this.dead = true;
    this.deathT = 0;
    this.deathCause = cause;
    this.hook = 0;
    this.anchor = null;
    this.loop.freeze(0.11);
    this.emit('death', cause);
    buzz([30, 50, 90]);
  }

  killNow() {
    this.die('debug');
  }

  // ------------------------------------------------------- anchor targeting

  /**
   * Deterministic, visible auto-target. The player "aims" by parking their
   * thumb on a side of the screen a beat early, which turns one button into
   * route planning. Recomputed every frame and drawn before you ever touch, so
   * the game never surprises you with the choice it made.
   */
  selectTarget(thumbX) {
    if (this.hook !== 0 || this.dead) return;
    let best = null;
    let bestCost = Infinity;
    const side = thumbX == null ? 0 : Math.sign(thumbX - VW / 2);

    for (const chunk of this.world.live()) {
      if (chunk.y1 < this.y - 700 || chunk.y0 > this.y + this.hookRange + 200) continue;
      for (const a of chunk.anchors) {
        const dx = a.x - this.x;
        const dy = a.y - this.y;
        const d = Math.hypot(dx, dy);
        if (d > this.hookRange || d < 60) continue;
        // What makes a good anchor is not just distance. It has to be AHEAD of
        // the fall (so the rope loads instead of yanking you backwards) and
        // laterally OFFSET (so the swing has an arc to develop). Measured, an
        // anchor straight below gives ~40px of lateral movement per second —
        // you fall past it and simply hang at bottom-dead-centre. One offset
        // by a rope-length gives a real arc, which is the whole game.
        const lateral = Math.abs(dx);
        let cost = d;
        if (dy < -260) cost += 900; // swinging back up is rarely what you want
        else if (dy < 0) cost += 380; // level or behind: costs you your dive
        else cost -= Math.min(dy, 380) * 0.5; // ahead of the fall: good
        if (lateral < 120) cost += 700; // straight below: no arc, no steering
        else cost -= Math.min(lateral, 420) * 0.9; // properly offset: best
        if (side !== 0 && Math.sign(a.x - VW / 2) === side) cost -= 260;
        if (a.risky) cost += 420; // anchors sitting inside a hazard's orbit
        if (cost < bestCost) {
          bestCost = cost;
          best = a;
        }
      }
    }
    this.target = best;
  }

  /**
   * Ten points of the swing you would get, by actually running the constrained
   * simulation forward. Guessing at this with a circle arc lies whenever
   * gravity matters, and a lying preview is worse than none.
   */
  predictArc() {
    this.arc.length = 0;
    const a = this.target;
    if (!a || this.hook !== 0 || this.dead) return;

    let x = this.x;
    let y = this.y;
    let vx = this.vx;
    let vy = this.vy;
    const L = clamp(Math.hypot(x - a.x, y - a.y), PHYS.ropeMin, PHYS.ropeMax);
    const dt = 1 / 60;
    for (let i = 0; i < 30; i++) {
      vy += PHYS.gravity * dt;
      const sp = Math.hypot(vx, vy);
      if (sp > 0) {
        const drag = this.dragHooked * sp * dt;
        vx -= vx * drag;
        vy -= vy * drag;
      }
      x += vx * dt;
      y += vy * dt;
      const dx = x - a.x;
      const dy = y - a.y;
      const d = Math.hypot(dx, dy);
      if (d > L && d > 1e-6) {
        const nx = dx / d;
        const ny = dy / d;
        x = a.x + nx * L;
        y = a.y + ny * L;
        const vn = vx * nx + vy * ny;
        if (vn > 0) {
          vx -= nx * vn;
          vy -= ny * vn;
        }
      }
      if (i % 3 === 0) this.arc.push(x, y);
    }
  }

  updateTrail(dt) {
    this.trailT += dt;
    if (this.trailT < 0.012) return;
    this.trailT = 0;
    const want = 10 + Math.round(Math.min(12, this.combo * 0.6));
    this.trail.unshift({ x: this.x, y: this.y });
    while (this.trail.length > want) this.trail.pop();
  }
}
