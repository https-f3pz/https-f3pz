// One run of FLASHOVER: the ship, the heat economy, the vent, the ignition,
// the director that spawns pressure, and everything that can kill you.
//
// Simulated at a fixed 1/120s substep. Nothing in here touches the canvas.

import {
  VW, C, HEAT, SHIP, ENEMIES, HUSK, CAPS, ERAS,
  budgetAt, eraAt,
} from './config.js';
import { makeWorld, fireProjectile, sweptMinDist, PROJ } from './entities.js';
import { clamp, lerp } from '../core/draw.js';
import { buzz } from '../core/input.js';
import * as audio from '../core/audio.js';

const DEG = Math.PI / 180;
const TAU = Math.PI * 2;

export class Run {
  constructor({ stats, seed, rng, fx, loop, view, save }) {
    this.s = stats;
    this.seed = seed;
    this.rng = rng;
    this.fx = fx;
    this.loop = loop;
    this.save = save;

    this.world = makeWorld();
    this.time = 0; // simulated run seconds
    this.score = 0;
    this.dead = false;
    this.deathT = 0;

    this.layout(view);

    // ---- ship
    this.x = VW / 2;
    this.y = this.shipMaxY - 40;
    this.px = this.x;
    this.py = this.y;
    this.anchorTouch = null;
    this.anchorShip = { x: 0, y: 0 };
    this.vx = 0;
    this.vy = 0;
    this.trail = [];
    for (let i = 0; i < 7; i++) this.trail.push({ x: this.x, y: this.y });
    this.trailT = 0;

    // ---- heat
    this.heat = stats.startHeat;
    this.sigma = 0;
    this.graceT = 0;
    this.fireT = 0;
    this.grazeScoreT = 0;
    this.sparkT = 0; // graze spark cadence

    // ---- vent
    this.ventCd = 0;
    this.armedT = 0;
    this.ventRing = null;
    this.iframes = 0;
    this.ventCount = 0;
    this.bestVent = 0;
    this.ventPayout = 1;
    this.everVented = false;

    // ---- ignition
    this.flashState = 0; // 0 none, 1 entry, 2 body
    this.flashT = 0;
    this.flashLock = 0;
    this.flashCount = 0;
    this.chainT = 0;
    this.chains = []; // transient arc list for the renderer

    this.sparkUsed = false;
    // A brand new player gets exactly one silent revive so run 1 is never a
    // 12-second humiliation.
    this.mercy = (save?.runs ?? 0) === 0 ? 1 : 0;

    // ---- director
    this.credit = 0;
    this.intensity = 0;
    this.intensityHold = 0;
    this.eraIndex = 0;
    this.sweepT = 0;
    this.sweepName = '';
    this.nextHusk = stats.huskFirst;
    this.huskAlive = 0;
    this.huskKills = 0;
    this.spawnedTypes = new Set();

    // ---- telemetry, used by the results screen to say something useful
    this.tel = {
      belowHeat30: 0, above50: 0, above70: 0, above85: 0, above90: 0, above95: 0,
      ventHeatSum: 0, ventHeatN: 0, kills: 0, peakHeat: 0, mult10T: 0, mult10Best: 0,
      grazeT: 0,
    };

    this.events = []; // drained by game.js each frame for audio/juice
  }

  layout(view) {
    this.view = view;
    const insT = view.insetTop;
    const insB = view.insetBottom;
    this.arena = {
      x: 16,
      w: VW - 32,
      y: insT + 64,
      h: Math.max(240, view.vh - insB - 30 - (insT + 64)),
    };
    this.shipMinY = this.arena.y + this.arena.h * 0.45;
    this.shipMaxY = this.arena.y + this.arena.h - 90;
  }

  emit(type, a, b) {
    this.events.push({ type, a, b });
  }

  // ------------------------------------------------------------- derived

  get mult() {
    return 1 + Math.floor(this.heat / this.s.multStep);
  }

  get scoreMult() {
    return this.mult * (this.flashState === 2 ? HEAT.flashScoreMult : 1);
  }

  get shots() {
    return 1 + this.s.extraShots + (this.heat >= 40 ? 1 : 0) + (this.heat >= 75 ? 1 : 0);
  }

  get armed() {
    return this.heat >= HEAT.ventGate && this.armedT >= HEAT.ventArmDelay && this.ventCd <= 0;
  }

  addScore(v) {
    this.score += v;
  }

  // ---------------------------------------------------------------- input

  // Called once per substep with the current pointer state, already converted
  // into logical space by game.js.
  steer(touch, dtScale) {
    if (!touch) {
      this.anchorTouch = null;
      return;
    }
    if (!this.anchorTouch) {
      this.anchorTouch = { x: touch.x, y: touch.y };
      this.anchorShip.x = this.x;
      this.anchorShip.y = this.y;
      return;
    }

    const gain = SHIP.gain;
    let tx = this.anchorShip.x + (touch.x - this.anchorTouch.x) * gain;
    let ty = this.anchorShip.y + (touch.y - this.anchorTouch.y) * gain;

    // During ignition entry the world slows but the player does not.
    const step = SHIP.maxStep * dtScale;
    let dx = tx - this.x;
    let dy = ty - this.y;
    const d = Math.hypot(dx, dy);
    if (d > step) {
      dx = (dx / d) * step;
      dy = (dy / d) * step;
    }
    const nx = this.x + dx;
    const ny = this.y + dy;

    const cx = clamp(nx, this.arena.x + 6, this.arena.x + this.arena.w - 6);
    const cy = clamp(ny, this.shipMinY, this.shipMaxY);
    this.x = cx;
    this.y = cy;

    // STICKY REBASE. Without this, dragging into a wall builds up invisible
    // travel debt and the ship stops answering the thumb. Re-anchoring keeps
    // the mapping honest, which is why a player almost never has to lift.
    if (Math.hypot(tx - cx, ty - cy) > SHIP.rebaseSlack) {
      this.anchorTouch = { x: touch.x, y: touch.y };
      this.anchorShip.x = cx;
      this.anchorShip.y = cy;
    }
  }

  // ---------------------------------------------------------------- update

  update(dt, touch) {
    if (this.dead) {
      this.deathT += dt;
      this.updateProjectilesDying(dt);
      return;
    }

    this.px = this.x;
    this.py = this.y;

    // Ignition entry slows the world; the player is compensated so the moment
    // reads as "I am fast", not "the game is molasses".
    const playerScale = this.flashState === 1 ? 1 / 0.55 : 1;
    this.steer(touch, playerScale);
    this.vx = (this.x - this.px) / dt;
    this.vy = (this.y - this.py) / dt;

    this.time += dt;
    this.iframes = Math.max(0, this.iframes - dt);
    this.ventCd = Math.max(0, this.ventCd - dt);
    this.flashLock = Math.max(0, this.flashLock - dt);

    this.updateEras();
    this.director(dt);
    this.updateEnemies(dt);
    this.updateProjectiles(dt);
    this.updateBullets(dt);
    this.updateCinders(dt);
    this.updateMotes(dt);
    this.updatePips(dt);

    this.updateHeat(dt);
    this.updateVent(dt);
    this.updateFlash(dt);
    this.updateGun(dt);

    this.collidePlayer(dt);
    this.updateTrail(dt);
    this.telemetry(dt);
  }

  telemetry(dt) {
    const t = this.tel;
    const h = this.heat;
    if (h < 30) t.belowHeat30 += dt;
    if (h >= 50) t.above50 += dt;
    if (h >= 70) t.above70 += dt;
    if (h >= 85) t.above85 += dt;
    if (h >= 90) t.above90 += dt;
    if (h >= 95) t.above95 += dt;
    if (h > t.peakHeat) t.peakHeat = h;
    if (this.sigma > 0.01) t.grazeT += dt;
    if (this.mult >= 10) {
      t.mult10T += dt;
      if (t.mult10T > t.mult10Best) t.mult10Best = t.mult10T;
    } else t.mult10T = 0;
  }

  updateTrail(dt) {
    this.trailT += dt;
    if (this.trailT >= 0.016) {
      this.trailT = 0;
      const p = this.trail.pop();
      p.x = this.x;
      p.y = this.y;
      this.trail.unshift(p);
    }
  }

  // ------------------------------------------------------------------ heat

  updateHeat(dt) {
    const R = this.s.grazeRadius;
    const w = this.world;
    let sigma = 0;
    const ax0 = this.px, ay0 = this.py, ax1 = this.x, ay1 = this.y;

    const consider = (e, ex0, ey0, ex1, ey1, radius, weightScale) => {
      const d = sweptMinDist(ax0, ay0, ax1, ay1, ex0, ey0, ex1, ey1) - radius;
      if (d < R) {
        const near = 1 - Math.max(0, d) / R;
        e.grazeT += dt;
        e.outT = 0;
        // Anti-camping: parking inside one slow cloud decays to 35% pay.
        let f = 1;
        if (e.grazeT > HEAT.campFull) {
          const k = Math.min(1, (e.grazeT - HEAT.campFull) / HEAT.campFade);
          f = lerp(1, HEAT.campFloor, k);
        }
        sigma += near * f * weightScale;
        return near;
      }
      e.outT += dt;
      if (e.outT > HEAT.campReset) e.grazeT = 0;
      return 0;
    };

    for (let i = 0; i < w.proj.count; i++) {
      const p = w.proj.items[i];
      if (p.converted) continue;
      consider(p, p.px, p.py, p.x, p.y, p.r, 1);
    }
    for (let i = 0; i < w.enemies.count; i++) {
      const e = w.enemies.items[i];
      consider(e, e.px, e.py, e.x, e.y, e.r, 1);
    }
    // CINDER fields you created yourself count as half a threat — you can
    // manufacture fuel, but never as much as facing real danger.
    if (this.s.cinder) {
      for (let i = 0; i < w.cinders.count; i++) {
        const c = w.cinders.items[i];
        consider(c, c.x, c.y, c.x, c.y, c.r * 0.5, 0.5);
      }
    }

    sigma = Math.min(sigma, this.s.sigmaCap);
    this.sigma = sigma;

    if (sigma > 0) {
      this.graceT = 0;
      this.heat += HEAT.gainPerUnit * sigma * this.s.gainMult * dt;
      // Score for living dangerously, independent of shooting anything.
      if (sigma >= 0.5) {
        this.grazeScoreT += dt;
        while (this.grazeScoreT >= 0.1) {
          this.grazeScoreT -= 0.1;
          this.addScore(2 * this.scoreMult);
        }
      }
      // The sparks that make grazing legible: they fly from the threat into
      // the hull, so the player sees the danger literally feeding them.
      this.sparkT += dt;
      if (this.sparkT >= 0.08) {
        this.sparkT = 0;
        this.emit('grazeSpark');
      }
    } else {
      this.graceT += dt;
      if (this.graceT > this.s.decayGrace) {
        this.heat = Math.max(0, this.heat - this.s.decay * dt);
      }
    }

    const prev = this.prevHeat ?? this.heat;
    this.heat = clamp(this.heat, 0, this.s.flashAt);
    // One rung of a pentatonic ladder each time a 10-heat line is crossed.
    const stepPrev = Math.floor(prev / 10);
    const stepNow = Math.floor(this.heat / 10);
    if (stepNow > stepPrev) this.emit('heatRung', stepNow);
    this.prevHeat = this.heat;

    // Vent arming, with a mandatory visible delay so the gun is never loaded
    // in secret.
    if (this.heat >= HEAT.ventGate) {
      if (this.armedT === 0) this.emit('ventArmed');
      this.armedT += dt;
    } else {
      this.armedT = 0;
    }

    audio.setIntensity(this.heat / 100);
  }

  // ------------------------------------------------------------------ vent

  requestVent() {
    if (this.dead) return false;
    if (this.heat < HEAT.ventGate) return false;
    if (this.armedT < HEAT.ventArmDelay) return false;
    if (this.ventCd > 0) return false;
    this.doVent();
    return true;
  }

  doVent() {
    const pre = this.heat;
    this.tel.ventHeatSum += pre;
    this.tel.ventHeatN++;
    this.ventCount++;
    this.everVented = true;

    // A vent pays for the heat it spends. Without this, cycling cheap vents
    // off the 35 gate is a safe, lucrative strategy that never engages with
    // the danger band — measured at 124k for a bot that never once ignited.
    // Venting at 100 is now worth ~2.4x per bullet what venting at the 35
    // gate is, on top of the multiplier already being higher — which is
    // exactly what the results screen tells you to do.
    this.ventPayout = 0.15 + 0.85 * (pre / this.s.flashAt);

    this.ventRing = { r: 0, t: 0, max: this.s.ventRadius, gained: 0 };
    this.heat = pre * this.s.ventRetain;
    this.armedT = this.heat >= HEAT.ventGate ? HEAT.ventArmDelay : 0;
    this.ventCd = this.s.ventCooldown;
    // AFTERBURN removes these i-frames entirely — that is the whole card.
    this.iframes = Math.max(this.iframes, this.s.ventIFrames);

    const flat = 200 * this.scoreMult * this.ventPayout;
    this.addScore(flat);
    this.ventRing.gained += flat;
    this.emit('vent', pre);
    buzz(12);
  }

  updateVent(dt) {
    const v = this.ventRing;
    if (!v) return;
    v.t += dt;
    const k = Math.min(1, v.t / HEAT.ventGrow);
    v.r = v.max * (1 - Math.pow(1 - k, 5)); // easeOutQuint

    const w = this.world;
    // Catch projectiles as the wavefront passes them.
    for (let i = 0; i < w.proj.count; i++) {
      const p = w.proj.items[i];
      if (p.converted) continue;
      if (Math.hypot(p.x - this.x, p.y - this.y) <= v.r) {
        const value = 25 * this.scoreMult * this.ventPayout;
        this.convertToMote(p, value);
        v.gained += value;
      }
    }
    // Backwards: damageEnemy can swap-remove, which would make a forward loop
    // skip whichever enemy got moved into the freed slot.
    for (let i = w.enemies.count - 1; i >= 0; i--) {
      const e = w.enemies.items[i];
      const d = Math.hypot(e.x - this.x, e.y - this.y);
      if (d <= v.r && !e.ventHit) {
        e.ventHit = true;
        const a = Math.atan2(e.y - this.y, e.x - this.x);
        e.x += Math.cos(a) * 70;
        e.y += Math.sin(a) * 70;
        e.stun = 0.25;
        this.damageEnemy(e, 4, i);
      }
    }

    if (k >= 1) {
      if (v.gained > this.bestVent) this.bestVent = v.gained;
      for (let i = 0; i < w.enemies.count; i++) w.enemies.items[i].ventHit = false;
      this.ventRing = null;
    }
  }

  convertToMote(p, value) {
    p.converted = 1;
    const m = this.world.motes.spawn();
    if (m) {
      m.x = m.sx = p.x;
      m.y = m.sy = p.y;
      m.t = 0;
      m.dur = 0.3;
      m.value = value;
      m.color = '#FFFFFF';
    } else {
      this.addScore(value);
    }
    // Mark for removal on the next projectile pass.
    p.dead = true;
  }

  // ------------------------------------------------------------- ignition

  updateFlash(dt) {
    if (this.flashState === 0) {
      if (this.heat >= this.s.flashAt && this.flashLock <= 0) {
        this.flashState = 1;
        this.flashT = 0;
        this.flashCount++;
        this.iframes = Math.max(this.iframes, 0.6);
        this.emit('flashEnter');
        buzz(28);
      }
      return;
    }

    this.flashT += dt;
    if (this.flashState === 1) {
      if (this.flashT >= HEAT.flashEntry) {
        this.flashState = 2;
        this.flashT = 0;
        this.chainT = 0;
      }
      return;
    }

    // Body: chain lightning does the killing so the player can concentrate on
    // staying inside the fire.
    this.chainT += dt;
    if (this.chainT >= 0.09) {
      this.chainT = 0;
      this.chainLightning();
    }
    if (this.flashT >= this.s.flashBody) {
      this.flashState = 0;
      this.heat = Math.min(this.heat, this.s.flashEndHeat);
      this.flashLock = HEAT.flashLockout;
      this.emit('flashEnd');
    }
  }

  chainLightning() {
    const w = this.world;
    this.chains.length = 0;
    let sx = this.x;
    let sy = this.y;

    // Pick the whole chain by object identity first, then apply damage. Doing
    // it in one pass would invalidate the indices as soon as something died.
    const picked = [];
    for (let link = 0; link < 3; link++) {
      let best = null;
      let bestD = 200;
      for (let i = 0; i < w.enemies.count; i++) {
        const e = w.enemies.items[i];
        if (picked.includes(e)) continue;
        const d = Math.hypot(e.x - sx, e.y - sy);
        if (d < bestD) {
          bestD = d;
          best = e;
        }
      }
      if (!best) break;
      picked.push(best);
      this.chains.push({ x0: sx, y0: sy, x1: best.x, y1: best.y });
      sx = best.x;
      sy = best.y;
    }
    for (const e of picked) this.damageEnemy(e, 3);
  }

  // --------------------------------------------------------------- the gun

  updateGun(dt) {
    this.fireT -= dt;
    if (this.fireT > 0) return;
    const interval = lerp(SHIP.fireSlow, SHIP.fireFast, this.heat / 100) * this.s.fireMult;
    this.fireT += Math.max(0.02, interval);

    const n = this.shots;
    const dmg = (SHIP.bulletDamage + (SHIP.bulletDamageAtMax - SHIP.bulletDamage) * (this.heat / 100)) * this.s.damageMult;
    const half = (n - 1) * 4.5;
    for (let i = 0; i < n; i++) {
      const a = n === 1 ? 0 : lerp(-half, half, i / (n - 1));
      const b = this.world.bullets.spawn();
      if (!b) break;
      b.x = b.px = this.x;
      b.y = b.py = this.y - 8;
      b.vx = Math.sin(a * DEG) * SHIP.bulletSpeed;
      b.vy = -Math.cos(a * DEG) * SHIP.bulletSpeed;
      b.dmg = dmg;
      b.pierce = this.s.pierce + this.s.piercePerFlash * this.flashCount;
      b.age = 0;
      b.hit = null;
    }
    this.emit('shoot');
  }

  updateBullets(dt) {
    const w = this.world;
    for (let i = w.bullets.count - 1; i >= 0; i--) {
      const b = w.bullets.items[i];
      b.px = b.x;
      b.py = b.y;

      if (this.s.homing) {
        let best = null;
        let bd = 160;
        for (let j = 0; j < w.enemies.count; j++) {
          const e = w.enemies.items[j];
          const d = Math.hypot(e.x - b.x, e.y - b.y);
          if (d < bd) {
            bd = d;
            best = e;
          }
        }
        if (best) {
          const want = Math.atan2(best.y - b.y, best.x - b.x);
          const cur = Math.atan2(b.vy, b.vx);
          let diff = ((want - cur + Math.PI * 3) % TAU) - Math.PI;
          const step = this.s.homing * DEG * dt; // degrees per second, not per substep
          const na = cur + clamp(diff, -step, step);
          const sp = Math.hypot(b.vx, b.vy);
          b.vx = Math.cos(na) * sp;
          b.vy = Math.sin(na) * sp;
        }
      }

      b.x += b.vx * dt;
      b.y += b.vy * dt;
      b.age += dt;

      if (b.y < this.arena.y - 30 || b.y > this.arena.y + this.arena.h + 30 || b.x < -20 || b.x > VW + 20) {
        w.bullets.release(i);
        continue;
      }

      // Bullet vs enemies, swept so fast bullets cannot skip small enemies.
      let consumed = false;
      for (let j = w.enemies.count - 1; j >= 0; j--) {
        const e = w.enemies.items[j];
        if (e === b.hit) continue;
        const d = sweptMinDist(b.px, b.py, b.x, b.y, e.px, e.py, e.x, e.y);
        if (d <= e.r + 2) {
          this.damageEnemy(e, b.dmg, j);
          if (b.pierce > 0) {
            b.pierce--;
            b.hit = e;
          } else {
            consumed = true;
          }
          break;
        }
      }
      if (consumed) w.bullets.release(i);
    }
  }

  damageEnemy(e, dmg, index) {
    if (e.hp <= 0) return; // already dead this frame; never kill it twice
    e.hp -= dmg;
    e.flash = 0.09;
    if (e.hp > 0) return;

    const w = this.world;
    // Only search the live prefix — the pool's tail still holds released
    // objects, and finding one there would remove the wrong enemy.
    let idx = index ?? -1;
    if (idx < 0 || w.enemies.items[idx] !== e) {
      idx = -1;
      for (let i = 0; i < w.enemies.count; i++) {
        if (w.enemies.items[i] === e) {
          idx = i;
          break;
        }
      }
    }
    const def = e.type;
    this.addScore(def.score * this.scoreMult);
    this.tel.kills++;
    if (this.s.heatPerKill) {
      this.heat = Math.min(this.s.flashAt, this.heat + (e.boss ? this.s.heatPerKill * 4 : this.s.heatPerKill));
    }
    if (this.s.cinder) {
      const c = w.cinders.spawn();
      if (c) {
        c.x = e.x;
        c.y = e.y;
        c.r = 34;
        c.life = 2.5;
        c.max = 2.5;
        c.grazeT = 0;
        c.outT = 0;
      }
    }
    if (e.boss) {
      this.huskAlive--;
      this.huskKills++;
      this.emit('bossKill', e.x, e.y);
    } else {
      this.emit('kill', e.x, e.y);
    }
    // A BLOOM killed mid-inflation never gets to burst — the telegraph is
    // genuinely cancellable, which is what makes it fair.
    if (idx >= 0) w.enemies.release(idx);
  }

  // -------------------------------------------------------------- director

  updateEras() {
    const era = eraAt(this.time);
    const idx = ERAS.indexOf(era);
    if (idx !== this.eraIndex) {
      this.eraIndex = idx;
      this.sweepT = 0.7;
      this.sweepName = era.name;
      this.loop.slowmo(0.5);
      setTimeout(() => this.loop.clearSlowmo(), 400);
      this.emit('era', era.name);
    }
    if (this.sweepT > 0) this.sweepT = Math.max(0, this.sweepT - 1 / 120);
  }

  director(dt) {
    // The player authors their own escalation: living in the danger band
    // makes the game harder, so being good is its own pressure.
    if (this.heat >= 70) {
      this.intensityHold += dt;
      while (this.intensityHold >= 4) {
        this.intensityHold -= 4;
        this.intensity = Math.min(1.2, this.intensity + 0.15);
      }
    } else if (this.heat < 40) {
      this.intensityHold = 0;
      this.intensity = Math.max(0, this.intensity - 0.05 * dt);
    }

    if (this.sweepT > 0) return; // no spawns during an era sweep

    // Boss cadence.
    if (this.time >= this.nextHusk && this.huskAlive === 0) {
      this.nextHusk = this.time + HUSK.every;
      this.spawnPip(VW / 2, this.arena.y - 10, HUSK, C.husk);
    }

    const era = ERAS[this.eraIndex];
    const B = (budgetAt(this.time) * this.s.density * era.cadence + this.intensity) *
      (this.huskAlive > 0 ? 0.45 : 1);
    this.credit += B * dt;

    const pool = [];
    for (const key of ['drifter', 'spinner', 'lancer', 'bloom']) {
      const def = ENEMIES[key];
      if (this.time >= def.first) pool.push(def);
    }
    if (!pool.length) return;

    const alive = this.world.enemies.count;
    if (alive >= CAPS.enemies) return;
    // Deliberately near-empty onboarding window.
    if (this.time < 12 && alive >= 3) return;

    const def = this.rng.weighted(pool, (d) => (this.spawnedTypes.has(d.id) ? 1 / d.cost : 3));
    if (this.credit < def.cost) return;

    // The first of every archetype always arrives alone, so the player meets
    // each new threat in isolation and learns what it does.
    const firstOfType = !this.spawnedTypes.has(def.id);
    if (firstOfType && alive > 0) return;

    this.credit -= def.cost;
    this.spawnedTypes.add(def.id);

    let x = this.rng.range(this.arena.x + 24, this.arena.x + this.arena.w - 24);
    if (firstOfType) x = VW / 2;
    this.spawnPip(x, this.arena.y - 10, def, def.color);
  }

  // Mandatory 400ms warning before anything enters. The game is unfair
  // without this and no exception is allowed anywhere in the codebase.
  spawnPip(x, y, def, color) {
    const p = this.world.pips.spawn();
    if (!p) {
      this.spawnEnemy(x, y, def);
      return;
    }
    p.x = x;
    p.y = y;
    p.life = 0.4;
    p.max = 0.4;
    p.color = color;
    p.def = def;
    this.emit('pip', x);
  }

  updatePips(dt) {
    const w = this.world;
    for (let i = w.pips.count - 1; i >= 0; i--) {
      const p = w.pips.items[i];
      p.life -= dt;
      if (p.life <= 0) {
        this.spawnEnemy(p.x, p.y, p.def);
        w.pips.release(i);
      }
    }
  }

  spawnEnemy(x, y, def) {
    const w = this.world;
    const e = w.enemies.spawn();
    if (!e) return;
    const boss = def === HUSK;
    e.type = def;
    e.boss = boss;
    e.maxHp = (boss ? HUSK.hp + HUSK.hpStep * this.huskKills : def.hp) * this.s.enemyHp;
    e.hp = e.maxHp;
    e.r = def.r;
    e.x = e.px = x;
    e.y = e.py = y;
    e.vx = 0;
    e.vy = 0;
    e.angle = 0;
    e.spin = 0;
    e.fireT = def.fireEvery ?? 2;
    e.state = 0;
    e.stateT = 0;
    e.age = 0;
    e.grazeT = 0;
    e.outT = 0;
    e.flash = 0;
    e.stun = 0;
    e.cycle = 0;
    e.arm = 0;
    e.ventHit = false;
    if (boss) {
      this.huskAlive++;
      e.ty = this.arena.y + 90;
    } else if (def.id === 'spinner') {
      e.ty = this.rng.range(this.arena.y + 60, this.arena.y + this.arena.h * 0.4);
    }
  }

  updateEnemies(dt) {
    const w = this.world;
    for (let i = w.enemies.count - 1; i >= 0; i--) {
      const e = w.enemies.items[i];
      e.px = e.x;
      e.py = e.y;
      e.age += dt;
      e.flash = Math.max(0, e.flash - dt);
      if (e.stun > 0) {
        e.stun -= dt;
        continue;
      }

      const def = e.type;
      if (e.boss) this.updateHusk(e, dt);
      else if (def.id === 'drifter') this.updateDrifter(e, dt);
      else if (def.id === 'spinner') this.updateSpinner(e, dt);
      else if (def.id === 'lancer') this.updateLancer(e, dt);
      else if (def.id === 'bloom') this.updateBloom(e, dt, i);

      // Keep enemies inside the play column so nothing is unreachable.
      e.x = clamp(e.x, this.arena.x + e.r, this.arena.x + this.arena.w - e.r);

      if (e.y > this.arena.y + this.arena.h + 60) w.enemies.release(i);
    }
  }

  updateDrifter(e, dt) {
    e.y += e.type.speed * dt;
    e.angle += dt * 1.2;
    e.fireT -= dt;
    if (e.fireT <= 0 && e.y > this.arena.y) {
      e.fireT = e.type.fireEvery;
      const a = Math.atan2(this.y - e.y, this.x - e.x);
      fireProjectile(this.world, e.x, e.y, Math.cos(a) * 130, Math.sin(a) * 130, PROJ.PELLET, C.pellet, 3.5, CAPS.projectiles);
      this.emit('enemyFire', e.x);
    }
  }

  updateSpinner(e, dt) {
    // Holds altitude, drifts laterally — a fat, stationary heat source that
    // rewards sitting inside its ring as it rotates.
    e.y += (e.ty - e.y) * Math.min(1, dt * 1.6);
    e.x += Math.sin(e.age * 0.7) * 22 * dt;
    e.angle += dt * 0.8;
    e.fireT -= dt;
    if (e.fireT <= 0) {
      e.fireT = e.type.fireEvery;
      e.arm += 17 * DEG;
      for (let i = 0; i < 6; i++) {
        const a = e.arm + (i / 6) * TAU;
        fireProjectile(this.world, e.x, e.y, Math.cos(a) * 95, Math.sin(a) * 95, PROJ.ORB, C.orb, 6, CAPS.projectiles);
      }
      this.emit('enemyFire', e.x);
    }
  }

  updateLancer(e, dt) {
    if (e.state === 0) {
      e.y += e.type.speed * dt;
      e.fireT -= dt;
      if (e.fireT <= 0 && e.y > this.arena.y + 20) {
        e.state = 1;
        e.stateT = e.type.telegraph;
        // Lock the dash direction at telegraph time: the line you see is the
        // line it takes, always.
        const a = Math.atan2(this.y - e.y, this.x - e.x);
        e.dashX = Math.cos(a);
        e.dashY = Math.sin(a);
        e.angle = a;
        this.emit('lancerTelegraph', e.x);
      }
    } else if (e.state === 1) {
      e.stateT -= dt;
      if (e.stateT <= 0) {
        e.state = 2;
        e.stateT = 0.9;
      }
    } else {
      e.x += e.dashX * e.type.dashSpeed * dt;
      e.y += e.dashY * e.type.dashSpeed * dt;
      e.stateT -= dt;
      if (e.stateT <= 0) {
        e.state = 0;
        e.fireT = e.type.fireEvery;
      }
    }
  }

  updateBloom(e, dt, index) {
    e.y += e.type.speed * dt;
    e.angle += dt * 0.6;
    if (e.state === 0) {
      e.fireT -= dt;
      if (e.fireT <= 0) {
        e.state = 1;
        e.stateT = e.type.inflate;
        this.emit('bloomInflate', e.x);
      }
    } else {
      e.stateT -= dt;
      if (e.stateT <= 0) {
        for (let i = 0; i < e.type.orbs; i++) {
          const a = (i / e.type.orbs) * TAU + e.angle;
          fireProjectile(
            this.world, e.x, e.y,
            Math.cos(a) * e.type.orbSpeed, Math.sin(a) * e.type.orbSpeed,
            PROJ.ORB, C.orb, 6, CAPS.projectiles
          );
        }
        this.emit('bloomBurst', e.x, e.y);
        this.world.enemies.release(index);
      }
    }
  }

  updateHusk(e, dt) {
    e.y += (e.ty - e.y) * Math.min(1, dt * 1.2);
    e.x += Math.sin(e.age * 0.5) * 30 * dt;
    e.angle += dt * 0.5;
    e.cycle += dt;
    e.fireT -= dt;

    const phase = Math.floor(e.cycle / HUSK.cycle) % 3;
    if (e.fireT <= 0) {
      if (phase === 0) {
        // Spiral: readable, dodgeable, and a superb graze farm.
        e.fireT = 0.1;
        e.arm += 24 * DEG;
        const arms = 3 + this.huskKills;
        for (let i = 0; i < arms; i++) {
          const a = e.arm + (i / arms) * TAU;
          fireProjectile(this.world, e.x, e.y, Math.cos(a) * 120, Math.sin(a) * 120, PROJ.PELLET, C.pellet, 3.5, CAPS.projectiles);
        }
      } else if (phase === 1) {
        e.fireT = 1.2;
        for (let i = 0; i < 3; i++) {
          const a = Math.atan2(this.y - e.y, this.x - e.x) + (i - 1) * 14 * DEG;
          fireProjectile(this.world, e.x, e.y, Math.cos(a) * 240, Math.sin(a) * 240, PROJ.SHARD, C.shard, 4, CAPS.projectiles);
        }
        this.emit('enemyFire', e.x);
      } else {
        e.fireT = 2.4;
        for (let i = 0; i < 2; i++) {
          this.spawnPip(e.x + (i ? 40 : -40), this.arena.y - 10, ENEMIES.drifter, C.pellet);
        }
      }
    }
  }

  // --------------------------------------------------------- projectiles

  updateProjectiles(dt) {
    const w = this.world;
    for (let i = w.proj.count - 1; i >= 0; i--) {
      const p = w.proj.items[i];
      if (p.dead) {
        w.proj.release(i);
        continue;
      }
      p.px = p.x;
      p.py = p.y;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.age += dt;
      if (
        p.age > p.life ||
        p.y < this.arena.y - 80 || p.y > this.arena.y + this.arena.h + 80 ||
        p.x < -40 || p.x > VW + 40
      ) {
        w.proj.release(i);
      }
    }
  }

  // After death everything turns white and rains down; the run is over but
  // the screen stays alive while the score counts up.
  updateProjectilesDying(dt) {
    const w = this.world;
    for (let i = w.proj.count - 1; i >= 0; i--) {
      const p = w.proj.items[i];
      p.px = p.x;
      p.py = p.y;
      p.vx *= Math.pow(0.02, dt);
      p.vy = lerp(p.vy, 90, Math.min(1, dt * 2));
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      if (p.y > this.arena.y + this.arena.h + 60) w.proj.release(i);
    }
  }

  updateCinders(dt) {
    const w = this.world;
    for (let i = w.cinders.count - 1; i >= 0; i--) {
      const c = w.cinders.items[i];
      c.life -= dt;
      if (c.life <= 0) {
        w.cinders.release(i);
        continue;
      }
      for (let j = w.enemies.count - 1; j >= 0; j--) {
        const e = w.enemies.items[j];
        if (Math.hypot(e.x - c.x, e.y - c.y) < c.r + e.r) this.damageEnemy(e, 2 * dt, j);
      }
    }
  }

  updateMotes(dt) {
    const w = this.world;
    for (let i = w.motes.count - 1; i >= 0; i--) {
      const m = w.motes.items[i];
      m.t += dt;
      const k = Math.min(1, m.t / m.dur);
      const e = 1 - Math.pow(1 - k, 3);
      m.x = lerp(m.sx, this.x, e);
      m.y = lerp(m.sy, this.y, e);
      if (k >= 1) {
        this.addScore(m.value);
        w.motes.release(i);
      }
    }
  }

  // ------------------------------------------------------------ collision

  collidePlayer(dt) {
    if (this.iframes > 0) return;
    const w = this.world;
    const hit = this.s.hitbox;

    for (let i = 0; i < w.proj.count; i++) {
      const p = w.proj.items[i];
      if (p.converted) continue;
      if (sweptMinDist(this.px, this.py, this.x, this.y, p.px, p.py, p.x, p.y) <= hit + p.r) {
        this.onLethal();
        return;
      }
    }
    for (let i = 0; i < w.enemies.count; i++) {
      const e = w.enemies.items[i];
      if (sweptMinDist(this.px, this.py, this.x, this.y, e.px, e.py, e.x, e.y) <= hit + e.r * 0.8) {
        this.onLethal();
        return;
      }
    }
  }

  onLethal() {
    // SECOND SPARK — the safety net exists only in the danger band, which is
    // exactly the behaviour the game wants to teach.
    if (!this.sparkUsed && this.heat >= HEAT.sparkGate) {
      this.sparkUsed = true;
      this.heat = 0;
      this.iframes = 1.2;
      const w = this.world;
      for (let i = 0; i < w.proj.count; i++) {
        const p = w.proj.items[i];
        if (!p.converted) this.convertToMote(p, 10 * this.mult);
      }
      this.loop.freeze(0.25);
      this.emit('spark');
      buzz([0, 40, 60, 40]);
      return;
    }

    if (this.mercy > 0) {
      this.mercy--;
      this.iframes = 1.4;
      this.emit('mercy');
      return;
    }

    this.dead = true;
    this.deathT = 0;
    this.flashState = 0;
    this.loop.freeze(0.42);
    this.emit('death');
    buzz([30, 60, 120]);
  }

  killNow() {
    this.mercy = 0;
    this.sparkUsed = true;
    this.onLethal();
  }
}
