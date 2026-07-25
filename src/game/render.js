// World rendering.
//
// Two hard rules, both from the design review and both load-bearing:
//   1. shadowBlur is never used. It is the single fastest way to lose 60fps
//      in Canvas 2D. Glow is done with additive over-draws instead.
//   2. Whatever the glow pass does, every hostile projectile's opaque white
//      core is redrawn on top of it. Killing geometry must always survive
//      the prettiness.

import { VW, C, HEAT, ERAS, HEAT_RAMP } from './config.js';
import { PROJ } from './entities.js';
import { polygon, withAlpha, mixHex, clamp, lerp, ease, cachedRadialGradient } from '../core/draw.js';

const TAU = Math.PI * 2;

export function heatColor(heat) {
  const h = clamp(heat, 0, 100);
  for (let i = 1; i < HEAT_RAMP.length; i++) {
    const [t1, c1] = HEAT_RAMP[i];
    const [t0, c0] = HEAT_RAMP[i - 1];
    if (h <= t1) return mixHex(c0, c1, (h - t0) / (t1 - t0));
  }
  return HEAT_RAMP[HEAT_RAMP.length - 1][1];
}

export class Renderer {
  constructor(fx) {
    this.fx = fx;
    this.t = 0;
  }

  // ------------------------------------------------------------ background

  background(ctx, run, view, opt) {
    const { vh } = view;
    if (opt.highContrast) {
      ctx.fillStyle = '#000000';
      ctx.fillRect(0, 0, VW, vh);
    } else {
      ctx.fillStyle = C.ink;
      ctx.fillRect(0, 0, VW, vh);
    }

    const era = ERAS[run ? run.eraIndex : 0];
    const heat = run ? run.heat : 0;
    const beat = 0.5 + 0.5 * Math.sin(this.t * (heat > 90 ? 8 : 4) * Math.PI);
    let grid = era.grid;
    if (!opt.highContrast && run && heat >= run.s.flashAt - 1) grid = C.pellet;

    // Scrolling horizon grid. Cheap, and it makes the arena feel like it is
    // moving even when the ship is holding still.
    const scroll = (this.t * 90) % 44;
    ctx.save();
    ctx.lineWidth = 1;
    ctx.strokeStyle = withAlpha(grid, opt.highContrast ? 0.1 : 0.16 + beat * 0.1);
    ctx.beginPath();
    for (let y = -44 + scroll; y < vh; y += 44) {
      ctx.moveTo(0, Math.round(y) + 0.5);
      ctx.lineTo(VW, Math.round(y) + 0.5);
    }
    for (let x = 0; x <= VW; x += 44) {
      ctx.moveTo(x + 0.5, 0);
      ctx.lineTo(x + 0.5, vh);
    }
    ctx.stroke();
    ctx.restore();
  }

  // ----------------------------------------------------------------- world

  world(ctx, run, view, opt) {
    const w = run.world;
    const hc = opt.highContrast;

    // -- cinder fields
    if (w.cinders.count) {
      ctx.save();
      ctx.globalCompositeOperation = hc ? 'source-over' : 'lighter';
      for (let i = 0; i < w.cinders.count; i++) {
        const c = w.cinders.items[i];
        const k = c.life / c.max;
        ctx.globalAlpha = 0.10 + k * 0.22;
        ctx.fillStyle = hc ? '#553300' : C.shard;
        ctx.beginPath();
        ctx.arc(c.x, c.y, c.r * (0.7 + k * 0.3), 0, TAU);
        ctx.fill();
      }
      ctx.restore();
    }

    // -- chain lightning, beneath the projectile layer and never near the ship
    if (run.flashState === 2 && run.chains.length) {
      ctx.save();
      ctx.globalAlpha = 0.55;
      ctx.strokeStyle = hc ? '#FFFFFF' : '#FFE9A8';
      ctx.lineWidth = 2;
      ctx.lineCap = 'round';
      // Cut a hole around the ship so lightning can never hide the bullet
      // that is about to kill you.
      ctx.beginPath();
      ctx.rect(0, 0, VW, view.vh);
      ctx.arc(run.x, run.y, 60, 0, TAU, true);
      ctx.clip('evenodd');
      ctx.beginPath();
      for (const a of run.chains) {
        ctx.moveTo(a.x0, a.y0);
        const mx = (a.x0 + a.x1) / 2;
        const my = (a.y0 + a.y1) / 2;
        const nx = -(a.y1 - a.y0);
        const ny = a.x1 - a.x0;
        const len = Math.hypot(nx, ny) || 1;
        const j = (Math.sin(this.t * 60 + a.x0) * 10) / len;
        ctx.lineTo(mx + nx * j, my + ny * j);
        ctx.lineTo(a.x1, a.y1);
      }
      ctx.stroke();
      ctx.restore();
    }

    this.enemies(ctx, run, opt);
    this.bullets(ctx, run, opt);
    this.projectiles(ctx, run, opt);

    // -- motes streaming into the hull
    if (w.motes.count) {
      ctx.save();
      ctx.fillStyle = '#FFFFFF';
      ctx.beginPath();
      for (let i = 0; i < w.motes.count; i++) {
        const m = w.motes.items[i];
        ctx.moveTo(m.x + 2.5, m.y);
        ctx.arc(m.x, m.y, 2.5, 0, TAU);
      }
      ctx.fill();
      ctx.restore();
    }

    this.pips(ctx, run, opt);
  }

  enemies(ctx, run, opt) {
    const w = run.world;
    const hc = opt.highContrast;
    ctx.save();
    ctx.lineWidth = 2;
    for (let i = 0; i < w.enemies.count; i++) {
      const e = w.enemies.items[i];
      const def = e.type;
      const flashing = e.flash > 0;
      const col = hc ? '#FFFFFF' : def.color;

      // LANCER telegraph: the line you see is exactly the line it takes.
      if (def.id === 'lancer' && e.state === 1) {
        const k = 1 - e.stateT / def.telegraph;
        ctx.save();
        ctx.globalAlpha = lerp(0.2, 0.9, k);
        ctx.strokeStyle = hc ? '#FFFFFF' : C.telegraph;
        ctx.lineWidth = 2;
        ctx.setLineDash([6, 6]);
        ctx.beginPath();
        ctx.moveTo(e.x, e.y);
        ctx.lineTo(e.x + e.dashX * 900, e.y + e.dashY * 900);
        ctx.stroke();
        ctx.restore();
      }

      let r = e.r;
      let scale = 1;
      if (def.id === 'bloom' && e.state === 1) {
        // Visible inflation — kill it now and the burst never happens.
        scale = lerp(1, 1.6, 1 - e.stateT / def.inflate);
      }
      if (flashing) scale *= 1.15;
      r *= scale;

      ctx.save();
      ctx.translate(e.x, e.y);
      ctx.rotate(e.angle);
      ctx.strokeStyle = flashing ? '#FFFFFF' : col;
      ctx.fillStyle = withAlpha(hc ? '#000000' : col, hc ? 1 : 0.16);
      ctx.lineWidth = e.boss ? 3 : 2;

      if (def.sides === 0) {
        ctx.beginPath();
        ctx.arc(0, 0, r, 0, TAU);
      } else {
        polygon(ctx, 0, 0, r, def.sides, 0);
      }
      ctx.fill();
      ctx.stroke();

      if (def.id === 'spinner') {
        ctx.beginPath();
        for (let k = 0; k < 6; k++) {
          const a = (k / 6) * TAU;
          ctx.moveTo(Math.cos(a) * r * 0.4, Math.sin(a) * r * 0.4);
          ctx.lineTo(Math.cos(a) * r * 1.25, Math.sin(a) * r * 1.25);
        }
        ctx.stroke();
      }
      if (e.boss) {
        // Segmented HP arc, readable at a glance without a number.
        ctx.rotate(-e.angle);
        ctx.lineWidth = 3;
        ctx.strokeStyle = withAlpha('#FFFFFF', 0.25);
        ctx.beginPath();
        ctx.arc(0, 0, r + 9, -Math.PI, 0);
        ctx.stroke();
        ctx.strokeStyle = hc ? '#FFFFFF' : C.gold;
        ctx.beginPath();
        ctx.arc(0, 0, r + 9, -Math.PI, -Math.PI + Math.PI * clamp(e.hp / e.maxHp, 0, 1));
        ctx.stroke();
      }
      ctx.restore();
    }
    ctx.restore();
  }

  bullets(ctx, run, opt) {
    const w = run.world;
    if (!w.bullets.count) return;
    ctx.save();
    // Player bullets are deliberately excluded from the glow pass: they must
    // never be confused with something that can kill you.
    ctx.strokeStyle = opt.highContrast ? '#00E5FF' : C.bullet;
    ctx.lineWidth = 2.5;
    ctx.lineCap = 'round';
    ctx.beginPath();
    for (let i = 0; i < w.bullets.count; i++) {
      const b = w.bullets.items[i];
      ctx.moveTo(b.x, b.y);
      ctx.lineTo(b.x - b.vx * 0.012, b.y - b.vy * 0.012);
    }
    ctx.stroke();
    ctx.restore();
  }

  projectiles(ctx, run, opt) {
    const w = run.world;
    if (!w.proj.count) return;
    const hc = opt.highContrast;

    // Pass 1 — additive glow, batched into one path per colour bucket.
    if (!hc && !opt.reduceGlow) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = 0.5;
      for (const col of [C.pellet, C.shard, C.orb]) {
        let any = false;
        ctx.beginPath();
        for (let i = 0; i < w.proj.count; i++) {
          const p = w.proj.items[i];
          if (p.color !== col || p.converted) continue;
          any = true;
          ctx.moveTo(p.x + p.r * 2.2, p.y);
          ctx.arc(p.x, p.y, p.r * 2.2, 0, TAU);
        }
        if (any) {
          ctx.fillStyle = col;
          ctx.fill();
        }
      }
      ctx.restore();
    }

    // Pass 2 — the readable shapes. Shape-coded, not hue-coded, so the game
    // stays legible for colour-blind players and in sunlight.
    ctx.save();
    for (const col of [C.pellet, C.shard, C.orb]) {
      let any = false;
      ctx.beginPath();
      for (let i = 0; i < w.proj.count; i++) {
        const p = w.proj.items[i];
        if (p.color !== col || p.converted) continue;
        any = true;
        if (p.kind === PROJ.PELLET) {
          ctx.moveTo(p.x + p.r, p.y);
          ctx.arc(p.x, p.y, p.r, 0, TAU);
        } else if (p.kind === PROJ.SHARD) {
          const m = Math.hypot(p.vx, p.vy) || 1;
          const ux = (p.vx / m) * 4.5;
          const uy = (p.vy / m) * 4.5;
          ctx.moveTo(p.x - ux, p.y - uy);
          ctx.lineTo(p.x + ux, p.y + uy);
        }
      }
      if (any) {
        if (col === C.shard) {
          ctx.strokeStyle = hc ? '#FFFFFF' : col;
          ctx.lineWidth = 2;
          ctx.lineCap = 'round';
          ctx.stroke();
        } else {
          ctx.fillStyle = hc ? '#FFFFFF' : col;
          ctx.fill();
        }
      }
    }
    // Hollow rings for ORBs.
    ctx.lineWidth = 2;
    ctx.strokeStyle = hc ? '#FFFFFF' : C.orb;
    ctx.beginPath();
    for (let i = 0; i < w.proj.count; i++) {
      const p = w.proj.items[i];
      if (p.kind !== PROJ.ORB || p.converted) continue;
      ctx.moveTo(p.x + p.r, p.y);
      ctx.arc(p.x, p.y, p.r, 0, TAU);
    }
    ctx.stroke();

    ctx.restore();
  }

  /**
   * Pass 3 — the invariant, drawn as its own pass so it can be sequenced after
   * the particle layer. An opaque white core on every hostile projectile, so
   * no glow, no lightning and no particle burst can ever hide the thing that
   * is about to kill you.
   */
  projectileCores(ctx, run, opt) {
    const w = run.world;
    if (!w.proj.count) return;
    ctx.save();
    ctx.fillStyle = '#FFFFFF';
    ctx.beginPath();
    for (let i = 0; i < w.proj.count; i++) {
      const p = w.proj.items[i];
      if (p.converted) continue;
      ctx.moveTo(p.x + 1.5, p.y);
      ctx.arc(p.x, p.y, 1.5, 0, TAU);
    }
    ctx.fill();
    if (opt.highContrast) {
      // In high contrast everything is white, so hostiles get a black rim to
      // separate them from the player's cyan.
      ctx.strokeStyle = '#000000';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      for (let i = 0; i < w.proj.count; i++) {
        const p = w.proj.items[i];
        if (p.converted) continue;
        ctx.moveTo(p.x + p.r + 1, p.y);
        ctx.arc(p.x, p.y, p.r + 1, 0, TAU);
      }
      ctx.stroke();
    }
    ctx.restore();
  }

  pips(ctx, run, opt) {
    const w = run.world;
    if (!w.pips.count) return;
    ctx.save();
    // Pinned just inside the arena: the spawn y sits above it, which would
    // put the arrow on top of the heat gauge.
    const py = run.arena.y + 4;
    for (let i = 0; i < w.pips.count; i++) {
      const p = w.pips.items[i];
      const k = p.life / p.max;
      const pulse = 0.55 + 0.45 * Math.sin(this.t * 12);
      ctx.globalAlpha = (0.4 + pulse * 0.6) * (0.35 + k * 0.65);
      ctx.fillStyle = opt.highContrast ? '#FFFFFF' : p.color;
      ctx.beginPath();
      ctx.moveTo(p.x, py + 14);
      ctx.lineTo(p.x - 7, py);
      ctx.lineTo(p.x + 7, py);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
  }

  // ---------------------------------------------------------------- player

  player(ctx, run, opt) {
    const hc = opt.highContrast;
    const hull = hc ? '#00E5FF' : C.hull;
    const heat = run.heat;
    // Normalised against the run's own ignition point, which POSITIVE
    // FEEDBACK raises to 120.
    const hk = clamp(heat / run.s.flashAt, 0, 1) * 100;

    if (!run.dead) {
      // -- trail
      if (!opt.reduceGlow) {
        ctx.save();
        ctx.strokeStyle = withAlpha(hc ? '#00E5FF' : C.trail, 0.5);
        ctx.lineWidth = 3;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.beginPath();
        ctx.moveTo(run.trail[0].x, run.trail[0].y);
        for (let i = 1; i < run.trail.length; i++) ctx.lineTo(run.trail[i].x, run.trail[i].y);
        ctx.stroke();
        ctx.restore();
      }

      // -- graze ring: the primary heat readout, and never invisible
      const R = run.s.grazeRadius;
      const bright = lerp(0.35, 1, hk / 100);
      const spin = this.t * lerp(20, 160, hk / 100) * (Math.PI / 180);
      ctx.save();
      ctx.translate(run.x, run.y);
      ctx.rotate(spin);
      ctx.globalAlpha = bright;
      ctx.strokeStyle = hc ? '#FFFFFF' : heatColor(hk);
      ctx.lineWidth = 1.5;
      ctx.setLineDash([5, 7]);
      ctx.beginPath();
      ctx.arc(0, 0, R, 0, TAU);
      ctx.stroke();
      ctx.setLineDash([]);

      // VENT ARMED: a solid outer band you can always see before you lift.
      if (run.heat >= HEAT.ventGate) {
        const arm = clamp(run.armedT / HEAT.ventArmDelay, 0, 1);
        ctx.globalAlpha = bright * arm;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(0, 0, R + 5, 0, TAU);
        ctx.stroke();
      }

      // Above 80 the ring throws arcs — the visual language of "about to go".
      if (hk > 80 && !opt.reduceGlow) {
        ctx.globalAlpha = 0.8;
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (let i = 0; i < 4; i++) {
          const a = ((this.t * 6 + i * 1.7) % 1) * TAU;
          const a2 = a + 0.7;
          ctx.moveTo(Math.cos(a) * R, Math.sin(a) * R);
          ctx.lineTo(Math.cos((a + a2) / 2) * (R + 7), Math.sin((a + a2) / 2) * (R + 7));
          ctx.lineTo(Math.cos(a2) * R, Math.sin(a2) * R);
        }
        ctx.stroke();
      }
      ctx.restore();

      // -- hull
      ctx.save();
      ctx.translate(run.x, run.y);
      ctx.globalAlpha = run.iframes > 0 ? 0.4 + 0.6 * Math.abs(Math.sin(this.t * 30)) : 1;
      ctx.strokeStyle = hull;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(0, -12);
      ctx.lineTo(7, 6);
      ctx.lineTo(0, 2);
      ctx.lineTo(-7, 6);
      ctx.closePath();
      ctx.stroke();
      ctx.restore();
    }

    // -- the hitbox. Always drawn, always opaque, always last. The player
    // must never have to guess what kills them.
    ctx.save();
    ctx.fillStyle = '#FFFFFF';
    ctx.beginPath();
    ctx.arc(run.x, run.y, run.s.hitbox, 0, TAU);
    ctx.fill();
    ctx.restore();

    // -- vent wavefront
    if (run.ventRing) {
      const v = run.ventRing;
      const k = Math.min(1, v.t / HEAT.ventGrow);
      ctx.save();
      ctx.globalAlpha = (1 - k) * 0.95;
      ctx.strokeStyle = '#FFFFFF';
      ctx.lineWidth = 3 + (1 - k) * 5;
      ctx.beginPath();
      ctx.arc(run.x, run.y, Math.max(1, v.r), 0, TAU);
      ctx.stroke();
      ctx.restore();
    }
  }

  // ------------------------------------------------------------- overlays

  overlays(ctx, run, view, opt) {
    const { vh } = view;
    const heat = run ? clamp(run.heat / run.s.flashAt, 0, 1) * 100 : 0;

    // Heat vignette: closes in and reddens as the run gets dangerous. This is
    // a mute-safe channel — it carries heat information without any sound.
    if (!opt.highContrast) {
      const kRaw = clamp((heat - 55) / 45, 0, 1);
      if (kRaw > 0.01) {
        // Quantised and cached: this ran createRadialGradient every frame,
        // which is one of the more expensive things Canvas 2D can be asked to
        // do 60 times a second.
        const k = Math.round(kRaw * 12) / 12;
        const g = cachedRadialGradient(
          ctx, `vig${k}${Math.round(vh)}`,
          VW / 2, vh / 2, vh * lerp(1.0, 0.68, k) * 0.42, vh * 0.75,
          [[0, 'rgba(0,0,0,0)'], [1, withAlpha(C.pellet, 0.16 + k * 0.34)]]
        );
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, VW, vh);
      }
    }

    // Ignition wash.
    if (run && run.flashState) {
      const a = run.flashState === 1 ? 0.35 : 0.10 + 0.05 * Math.sin(this.t * 24);
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = withAlpha('#FFFFFF', a);
      ctx.fillRect(0, 0, VW, vh);
      ctx.restore();
    }

    // Era sweep: a clockwise white wipe that reframes the run.
    if (run && run.sweepT > 0) {
      const k = 1 - run.sweepT / 0.7;
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = withAlpha('#FFFFFF', 0.20 * (1 - k));
      ctx.beginPath();
      ctx.moveTo(VW / 2, vh / 2);
      ctx.arc(VW / 2, vh / 2, vh, -Math.PI / 2, -Math.PI / 2 + TAU * ease.outCubic(k));
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }
  }
}
