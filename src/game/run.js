// One run.
//
// The ship holds a single angle around the bore and the tube comes at it. All
// collision is angular and resolved at the exact z of each obstacle plane, so
// it is unaffected by however hard the renderer is bending the picture — the
// distortion can lie to the player, but never to the simulation.
//
// Fixed 1/120s substep. Nothing here touches the canvas.

import { SPEED, SHIP, GRAZE, WARP, zoneAt, upgradeValue, speedFloor } from './config.js';
import { Track, arcsAt, clearance, angleDiff } from './track.js';
import { clamp } from '../core/draw.js';
import { buzz } from '../core/input.js';

const TAU = Math.PI * 2;

export class Run {
  constructor({ seed, save, loop, view, daily = false }) {
    this.seed = seed >>> 0;
    this.save = save;
    this.loop = loop;
    this.daily = daily;
    this.track = new Track(this.seed);
    this.view = view;

    this.turnRate = upgradeValue(save, 'grip');
    this.lens = upgradeValue(save, 'lens');
    this.grazeGain = upgradeValue(save, 'intake');
    // The warp a clip is survivable at. Cracks lower it, clean gates work it
    // back up, and it is the number that decides how long a run lasts.
    this.shatterMax = upgradeValue(save, 'hull');
    this.shatter = this.shatterMax;

    this.z = 0;
    this.pz = 0;
    this.angle = 0;
    this.angVel = 0;
    this.speed = SPEED.start;
    this.topSpeed = SPEED.start;

    this.dist = 0;
    this.score = 0;
    this.shards = 0;
    this.combo = 0;
    this.comboT = 0;
    this.bestCombo = 0;
    this.grazes = 0;
    this.gates = 0;
    this.cleanGates = 0;
    this.clips = 0;
    this.dead = false;
    this.deathT = 0;

    this.zone = zoneAt(0);
    this.milestone = 0;
    this.bestKnown = save?.best ?? 0;
    this.passedBest = (save?.best ?? 0) <= 0;

    this.hitFlash = 0;
    this.grazeFlash = 0;
    this.anchorTouch = null;
    this.anchorAngle = 0;

    this._arcs = []; // reused every collision test; the hot path allocates nothing
    this.events = [];
    this.track.ensure(0, 8000);
  }

  layout(view) {
    this.view = view;
  }

  emit(type, a, b) {
    this.events.push({ type, a, b });
  }

  get mult() {
    return 1 + GRAZE.multPer * Math.min(this.combo, GRAZE.maxCombo);
  }

  /** 0..1 — how fast we are, and therefore how hard the view lies. */
  get warp() {
    const k = clamp((this.speed - SPEED.start) / (SPEED.max - SPEED.start), 0, 1);
    return k * this.lens;
  }

  // ---------------------------------------------------------------- steering

  steer(touch, dt) {
    if (!touch) {
      this.anchorTouch = null;
      // Coast to a stop rather than snapping, so letting go is not a jolt.
      this.angVel *= Math.pow(0.0015, dt);
      this.angle += this.angVel * dt;
      return;
    }
    if (!this.anchorTouch) {
      this.anchorTouch = touch.x;
      this.anchorAngle = this.angle;
    }
    // Relative drag: the thumb can start anywhere, and re-grip whenever.
    const want = this.anchorAngle + (touch.x - this.anchorTouch) * SHIP.dragGain;
    // `want` accumulates without bound while `angle` is wrapped to [0, TAU)
    // every frame, so the raw difference is off by a whole turn near the seam.
    // Taking the shortest signed arc is what stops the ship from reversing —
    // and stalling under the rebase below — every time you rotate past zero.
    let d = angleDiff(want, this.angle);
    const step = Math.min(SHIP.maxStep, this.turnRate * dt);
    d = clamp(d, -step, step);
    this.angle += d;
    this.angVel = d / dt;

    // Sticky rebase: without this, dragging past the thumb's reach builds up
    // invisible travel debt and the ship stops answering.
    if (Math.abs(angleDiff(want, this.angle)) > 1.2) {
      this.anchorTouch = touch.x;
      this.anchorAngle = this.angle;
    }
  }

  // ---------------------------------------------------------------- update

  update(dt, touch) {
    if (this.dead) {
      this.deathT += dt;
      this.speed *= Math.pow(0.02, dt);
      this.z += this.speed * dt;
      return;
    }

    this.steer(touch, dt);
    this.angle = ((this.angle % TAU) + TAU) % TAU;

    // Anything above the floor bleeds away, and the bore then drags you back
    // up to whatever it is pulling at this depth. A clip drops you well under
    // the floor, so the distortion visibly collapses and rebuilds over about a
    // second — that recovery is the real cost of a hit.
    this.speed = Math.max(SPEED.min, this.speed - SPEED.decay * dt);
    const floor = speedFloor(this.z);
    if (this.speed < floor) this.speed = floor - (floor - this.speed) * Math.pow(SPEED.pullBack, dt);
    if (this.speed > SPEED.max) this.speed = SPEED.max;

    this.pz = this.z;
    this.z += this.speed * dt;
    this.dist = this.z;
    this.track.ensure(this.z - 400, this.z + 7000);

    this.cross(dt);

    if (this.comboT > 0) {
      this.comboT -= dt;
      if (this.comboT <= 0 && this.combo > 0) {
        this.emit('comboEnd', this.combo);
        this.combo = 0;
      }
    }
    if (this.hitFlash > 0) this.hitFlash -= dt;
    if (this.grazeFlash > 0) this.grazeFlash -= dt;
    if (this.speed > this.topSpeed) this.topSpeed = this.speed;

    this.progress(dt);
  }

  // Every obstacle plane crossed this substep is resolved at its own z. At
  // 5200 units/sec a substep covers 43 units, so more than one plane can pass
  // in a single step and skipping any of them would be a phantom survival.
  cross(dt) {
    const t = this.z / 1000; // obstacle clocks run on distance, not wall time
    for (const p of this.track.planes()) {
      if (p.passed || p.z <= this.pz || p.z > this.z) continue;
      p.passed = true;

      const arcs = arcsAt(p, t, this._arcs);
      // Measure from the ship's EDGE, not its centre. Without the hull's own
      // angular width every sector seam scores exactly zero clearance, so
      // parking on one passed every plane and grazed every plane — a line that
      // never steers and never dies.
      const gap = clearance(this.angle, arcs) - SHIP.radius;

      if (gap < 0) {
        this.clip(p);
        continue;
      }

      this.gates++;
      this.cleanGates++;
      this.speed = Math.min(SPEED.max, this.speed + SPEED.gateGain);

      if (gap < GRAZE.angle) {
        // A near miss is the only real way to accelerate, so the fast line and
        // the dangerous line are the same line.
        this.grazes++;
        this.combo++;
        if (this.combo > this.bestCombo) this.bestCombo = this.combo;
        this.comboT = GRAZE.window;
        this.speed = Math.min(SPEED.max, this.speed + this.grazeGain);
        // Shaving the wall is what anneals the hull, so the risky line is also
        // the one that lets the run continue.
        this.shatter = Math.min(this.shatterMax, this.shatter + SPEED.anneal);
        this.score += 90 * this.combo;
        this.shards += 1;
        this.grazeFlash = 0.18;
        p.grazed = true;
        this.emit('graze', this.combo, gap);
      }
    }
  }

  clip(p) {
    this.clips++;
    this.cleanGates = 0;
    this.hitFlash = 0.4;
    if (this.combo > 0) {
      this.emit('comboEnd', this.combo);
      this.combo = 0;
      this.comboT = 0;
    }
    this.loop.freeze(0.07);
    this.emit('clip');

    // Scraping a wall is survivable while you are slow and the picture is
    // honest. Past the shatter point it is not — which makes the distortion a
    // real risk rather than decoration, and ties the failure state directly to
    // the thing the game is about. Tested at the speed of impact, before the
    // penalty, because that is the speed you actually hit the wall at.
    if (this.warp >= this.shatter) {
      this.die('shattered');
      return;
    }

    this.speed = Math.max(SPEED.min, this.speed * SPEED.hitLoss);
    this.shatter = Math.max(0.04, this.shatter - SPEED.crack);
    buzz(24);
  }

  progress(dt) {
    this.shatter = Math.max(0.04, this.shatter - SPEED.fatigue * dt);
    this.score += this.speed * dt * 0.1 * this.mult;
    this.shards += (this.speed * dt) / 900;

    const stone = (this.milestone + 1) * 10000;
    if (this.dist >= stone) {
      this.milestone++;
      this.emit('milestone', this.milestone * 1000);
    }

    const z = zoneAt(this.dist);
    if (z !== this.zone) {
      this.zone = z;
      this.emit('zone', z.name);
    }

    if (!this.passedBest && this.dist > this.bestKnown) {
      this.passedBest = true;
      this.emit('best');
    }
  }

  die(cause) {
    if (this.dead || this.god) return; // `god` is set only by tools/shots.mjs
    this.dead = true;
    this.deathT = 0;
    this.deathCause = cause || 'shattered';
    this.loop.freeze(0.12);
    this.emit('death', this.deathCause);
    buzz([30, 60, 100]);
  }

  killNow() {
    this.die('debug');
  }
}
