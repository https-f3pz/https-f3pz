// Rendering.
//
// A real perspective projection down a tube, deliberately corrupted by speed.
// Four distortions, all driven by one 0..1 `warp` value that IS the player's
// velocity:
//
//   FIELD OF VIEW  widens, so the walls rush past instead of drifting
//   BARREL         bows the bore outward, hardest at the screen edges
//   SMEAR          streaks every edge along its own screen-space motion
//   DOPPLER        shifts the far end blue and the near end red
//
// The consequence is the design: the better you play, the faster you go, and
// the less the picture can be trusted. The simulation is unaffected — all
// collision is angular — so the view lies to the player and never to the game.

import { VW, TUBE, WARP, paletteBlend } from './config.js';
import { ringGapFor } from './world.js';
import { mixHex, withAlpha, clamp, lerp, shiftHue } from '../core/draw.js';

const TAU = Math.PI * 2;

export class Renderer {
  constructor() {
    this.t = 0;
    this.cx = VW / 2;
    this.cy = 600;
    this.R = 800;
    this.roll = 0;
    // Scratch buffers: the projection runs thousands of times a frame and must
    // not allocate.
    this._arcs = [];
    this._pt = { x: 0, y: 0, s: 0 };
  }

  // Palettes cycle rather than ending: eight of them, crossfading, with the
  // whole set hue-rotated 47 degrees each complete cycle. gcd(47, 360) = 1, so
  // it takes 360 cycles to land on a colour you have already seen. The old
  // fixed zone list simply froze on its last entry, which is fine for a
  // three-minute run and useless for a game measured in months.
  palette(dist) {
    const b = paletteBlend(dist);
    const k = Math.round(b.k * 12) / 12;
    const mix = (a, c) => {
      const m = mixHex(a, c, k);
      return b.hue ? shiftHue(m, b.hue) : m;
    };
    return {
      wall: mix(b.from.wall, b.to.wall),
      edge: mix(b.from.edge, b.to.edge),
      hazard: mix(b.from.hazard, b.to.hazard),
      fog: mix(b.from.fog, b.to.fog),
      name: b.name,
    };
  }

  setup(run, view) {
    this.cx = VW / 2;
    this.cy = view.vh * 0.44;
    this.R = Math.hypot(VW, view.vh) * 0.5;
    const w = run.warp;
    this.w = w;
    this.fov = lerp(WARP.fovMin, WARP.fovMax, w);
    // Turning rolls the camera slightly — it reads as banking and it is the
    // only cue that the tube is rotating around you rather than you around it.
    this.roll = lerp(this.roll, clamp(-run.angVel * WARP.roll, -0.5, 0.5), 0.15);
    this.camZ = run.z - TUBE.near;
  }

  /**
   * World (angle around bore, radius, z) -> screen, with the velocity
   * distortion applied. Writes into a scratch point to stay allocation-free.
   */
  project(worldAngle, r, z, shipAngle) {
    const p = this._pt;
    const dz = z - this.camZ;
    if (dz <= 12) {
      p.s = -1;
      return p;
    }
    // Rotate the bore so the ship sits at the bottom of the screen.
    const a = worldAngle - shipAngle + Math.PI / 2 + this.roll;
    const x = Math.cos(a) * r;
    const y = Math.sin(a) * r;
    const s = this.fov / dz;
    let px = x * s;
    let py = y * s;

    // Barrel: push everything outward in proportion to how far out it already
    // is. At rest this is identity; at full speed the bore visibly bulges.
    if (this.w > 0.001) {
      const rr = Math.hypot(px, py) / this.R;
      const k = 1 + WARP.barrel * this.w * rr * rr;
      px *= k;
      py *= k;
    }
    p.x = this.cx + px;
    p.y = this.cy + py;
    p.s = s;
    return p;
  }

  /** Depth fade toward the zone's fog colour, plus the Doppler shift. */
  depthColour(base, dz, pal) {
    const far = clamp(dz / TUBE.far, 0, 1);
    let c = mixHex(base, pal.fog, far * 0.82);
    if (this.w > 0.02) {
      // Far end toward blue, near end toward red — an aberration cue that
      // makes speed legible even in a still frame.
      const shift = (0.5 - far) * 2; // +1 near, -1 far
      const target = shift > 0 ? '#ff2a1e' : '#4aa8ff';
      c = mixHex(c, target, Math.abs(shift) * this.w * WARP.doppler * 0.72);
    }
    return c;
  }

  // ------------------------------------------------------------ background

  background(ctx, run, view, pal) {
    const g = ctx.createLinearGradient(0, 0, 0, view.vh);
    g.addColorStop(0, pal.fog);
    g.addColorStop(0.45, mixHex(pal.fog, pal.wall, 0.35));
    g.addColorStop(1, pal.fog);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, VW, view.vh);

    // The vanishing point glows — it is where everything is coming from.
    const gr = ctx.createRadialGradient(this.cx, this.cy, 0, this.cx, this.cy, 260 + this.w * 240);
    gr.addColorStop(0, withAlpha(pal.edge, 0.30 + this.w * 0.35));
    gr.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = gr;
    ctx.fillRect(0, 0, VW, view.vh);
  }

  // ----------------------------------------------------------------- tube

  tube(ctx, run, view, pal, opt) {
    const sides = TUBE.sides;
    const rad = TUBE.radius;
    // Rings double their spacing as the bore speeds up, so they keep arriving
    // at a readable rate instead of strobing. Doubling rather than scaling
    // means the surviving rings stay exactly where they were — every other one
    // simply drops out — so the tube never appears to slide underneath you.
    const gap = ringGapFor(run.speed);
    const startZ = Math.floor((this.camZ + TUBE.near * 0.5) / gap) * gap;
    const smear = opt.reduceGlow ? 0 : WARP.smear * this.w;

    // Longitudinal edges: the eight seams running away from you. These carry
    // most of the sense of speed, so they get the smear treatment.
    for (let i = 0; i < sides; i++) {
      const a = (i / sides) * TAU;
      ctx.beginPath();
      let started = false;
      for (let z = startZ; z < this.camZ + TUBE.far; z += gap) {
        const p = this.project(a, rad, z, run.angle);
        if (p.s < 0) continue;
        if (!started) {
          ctx.moveTo(p.x, p.y);
          started = true;
        } else ctx.lineTo(p.x, p.y);
      }
      if (!started) continue;
      ctx.strokeStyle = withAlpha(pal.edge, 0.16 + this.w * 0.12);
      ctx.lineWidth = 1.5 + this.w * 1.5;
      ctx.stroke();
    }

    // Rings. Nearer rings are brighter, wider and — at speed — smeared into
    // the direction they are travelling on screen.
    for (let z = startZ; z < this.camZ + TUBE.far; z += gap) {
      const dz = z - this.camZ;
      const fade = 1 - clamp(dz / TUBE.far, 0, 1);
      if (fade <= 0.02) continue;
      const col = this.depthColour(pal.edge, dz, pal);

      for (let pass = smear > 0.02 ? 0 : 1; pass < 2; pass++) {
        // Pass 0 is the smear: the same ring drawn slightly nearer, faint.
        const zz = pass === 0 ? z - run.speed * 0.016 * smear * 6 : z;
        ctx.beginPath();
        for (let i = 0; i <= sides; i++) {
          const a = ((i % sides) / sides) * TAU;
          const p = this.project(a, rad, zz, run.angle);
          if (p.s < 0) break;
          if (i === 0) ctx.moveTo(p.x, p.y);
          else ctx.lineTo(p.x, p.y);
        }
        ctx.closePath();
        ctx.strokeStyle = withAlpha(col, pass === 0 ? fade * 0.22 : fade * 0.75);
        ctx.lineWidth = (pass === 0 ? 4 : 1.6) + fade * this.w * 2.5;
        ctx.stroke();
      }
    }
  }

  // ---------------------------------------------------------------- ship

  ship(ctx, run, view, pal) {
    // Always at the bottom of the bore, on the player plane. Drawn from the
    // same projection as everything else, so it banks and bows with the world
    // — but its world radius is divided back out by the focal length, so its
    // SCREEN position is fixed. Without that the widening field of view slides
    // the ship off the bottom of the display at speed, and the one thing that
    // must never become unreadable is where you are.
    const r = TUBE.radius * 0.80 * (WARP.fovMin / this.fov);
    const p = this.project(run.angle, r, run.z + 26, run.angle);
    if (p.s < 0) return;
    const size = 26 + this.w * 10;
    ctx.save();
    ctx.translate(p.x, p.y);
    // Bank into the turn.
    ctx.rotate(clamp(run.angVel * 0.06, -0.5, 0.5));
    for (const pass of [{ s: 2.1, a: 0.22 }, { s: 1, a: 1 }]) {
      ctx.fillStyle = withAlpha(run.hitFlash > 0 ? '#ff3b3b' : '#ffffff', pass.a);
      ctx.beginPath();
      ctx.moveTo(0, -size * 0.75 * pass.s);
      ctx.lineTo(size * 0.62 * pass.s, size * 0.5 * pass.s);
      ctx.lineTo(0, size * 0.22 * pass.s);
      ctx.lineTo(-size * 0.62 * pass.s, size * 0.5 * pass.s);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();

    // Thrust plume, length driven by speed.
    if (this.w > 0.03) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      const g = ctx.createLinearGradient(p.x, p.y, p.x, p.y + 60 + this.w * 120);
      g.addColorStop(0, withAlpha(pal.edge, 0.5 * this.w + 0.15));
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.fillRect(p.x - 26, p.y, 52, 70 + this.w * 130);
      ctx.restore();
    }
  }

  // ------------------------------------------------------------- overlays

  overlays(ctx, run, view, pal, opt) {
    const vh = view.vh;

    // Speed vignette closes in as the warp rises.
    if (this.w > 0.02) {
      const g = ctx.createRadialGradient(this.cx, this.cy, vh * (0.44 - this.w * 0.16), this.cx, this.cy, vh * 0.80);
      g.addColorStop(0, 'rgba(0,0,0,0)');
      g.addColorStop(1, `rgba(0,0,0,${(0.18 + this.w * 0.42).toFixed(3)})`);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, VW, vh);
    }

    // Chromatic separation at the edges — the lens giving up.
    if (this.w > WARP.shakeAt && !opt.reduceGlow) {
      const k = (this.w - WARP.shakeAt) / (1 - WARP.shakeAt);
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = k * 0.13;
      ctx.fillStyle = '#ff2b5e';
      ctx.fillRect(-6 * k, 0, VW, vh);
      ctx.fillStyle = '#2bd7ff';
      ctx.fillRect(6 * k, 0, VW, vh);
      ctx.restore();
    }

    if (run.hitFlash > 0) {
      ctx.save();
      ctx.fillStyle = withAlpha('#ff2020', run.hitFlash * 0.5);
      ctx.fillRect(0, 0, VW, vh);
      ctx.restore();
    }
    if (run.grazeFlash > 0 && !opt.reduceGlow) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = withAlpha('#ffd34f', run.grazeFlash * 0.28);
      ctx.fillRect(0, 0, VW, vh);
      ctx.restore();
    }
  }
}
