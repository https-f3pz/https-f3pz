// The permanent furniture of the bore.
//
// An idle game is played for months, and the honest problem with that is that
// the picture stops being news. Numbers grow forever; a tunnel does not. So the
// tunnel gains PERMANENT GEOMETRY on a monotone clock — one new layer at each
// milestone band, and none of them ever goes away again.
//
// Two properties matter more than any individual effect:
//
//   * STRICTLY ADDITIVE. Nothing here ever regresses, because `band` is derived
//     from world.scale, which is a running max over integer counters. A player
//     who comes back after a week sees a tunnel they have never seen, and a
//     collapse never takes a layer back.
//   * DRAWN THROUGH THE SAME PROJECTION. Every layer goes through
//     Renderer.project(), so it inherits the field-of-view widening, the barrel
//     bow and the Doppler shift for free. They are not overlays on the tunnel;
//     they are in it.
//
// The best of them is DRIVE RINGS: one lit ring per owned tier, thickness set
// by how many you own. Buying something does not increment a label — it
// visibly thickens a ring you can see coming toward you out of the dark.

import { TUBE, WARP } from './config.js';
import { withAlpha, clamp } from '../core/draw.js';
import * as B from '../core/big.js';

const TAU = Math.PI * 2;

/** Which band unlocks which layer. Odd/even alternation is deliberate: every
 *  band crossing is an event, but only some of them add geometry. */
export const LAYERS = [
  { band: 1, id: 'dust', name: 'DUST' },
  { band: 3, id: 'struts', name: 'STRUTS' },
  { band: 5, id: 'drive', name: 'DRIVE RINGS' },
  { band: 7, id: 'plates', name: 'PLATES' },
  { band: 9, id: 'accretion', name: 'ACCRETION' },
  { band: 10, id: 'horizon', name: 'HORIZON RING' },
  { band: 12, id: 'lensing', name: 'LENSING' },
  { band: 13, id: 'escorts', name: 'ESCORTS' },
  { band: 15, id: 'second', name: 'SECOND BORE' },
  { band: 17, id: 'inversion', name: 'INVERSION' },
];

export function layersAt(band) {
  return LAYERS.filter((l) => band >= l.band);
}

export function layerNamesBetween(fromBand, toBand) {
  return LAYERS.filter((l) => l.band > fromBand && l.band <= toBand).map((l) => l.name);
}

export function has(band, id) {
  const l = LAYERS.find((x) => x.id === id);
  return !!l && band >= l.band;
}

/**
 * Everything drawn INSIDE the tube, between the walls and the ship.
 * `r` is the Renderer (for project/depthColour), `w` is the world adapter.
 */
export function drawLayers(ctx, r, w, st, view, pal, opt) {
  const band = w.band;
  if (band < 1) return;

  if (has(band, 'struts')) struts(ctx, r, w, pal, opt);
  if (has(band, 'plates') && !opt.reduceGlow) plates(ctx, r, w, pal, opt);
  if (has(band, 'second')) secondBore(ctx, r, w, pal);
  if (has(band, 'drive')) driveRings(ctx, r, w, st, pal);
  if (has(band, 'horizon')) horizonRing(ctx, r, w, pal);
  if (has(band, 'lensing')) lensing(ctx, r, w, pal);
  if (has(band, 'accretion')) accretion(ctx, r, w, pal);
}

// Longitudinal ribs between the eight seams. Subdivided along z so that the
// piecewise-linear barrel distortion actually bows them — a two-point line
// would stay straight and give the whole effect away.
function struts(ctx, r, w, pal, opt) {
  const sides = TUBE.sides;
  const rad = TUBE.radius * 0.985;
  const far = TUBE.far * 0.9;
  ctx.strokeStyle = withAlpha(pal.wall, 0.5);
  ctx.lineWidth = 1 + w.warp;
  for (let i = 0; i < sides; i++) {
    const a = ((i + 0.5) / sides) * TAU;
    ctx.beginPath();
    let started = false;
    for (let z = r.camZ + TUBE.near * 0.6; z < r.camZ + far; z += 200) {
      const p = r.project(a, rad, z, w.angle);
      if (p.s < 0) continue;
      if (!started) { ctx.moveTo(p.x, p.y); started = true; }
      else ctx.lineTo(p.x, p.y);
    }
    if (started) ctx.stroke();
  }
}

// Filled quads between consecutive rings: the tube stops being a wireframe.
function plates(ctx, r, w, pal, opt) {
  const sides = TUBE.sides;
  const rad = TUBE.radius;
  const gap = 680;
  const startZ = Math.floor((r.camZ + TUBE.near) / gap) * gap;
  const alpha = 0.10 + 0.25 * w.warp;
  for (let z = startZ; z < r.camZ + TUBE.far * 0.75; z += gap) {
    const dz = z - r.camZ;
    const fade = 1 - clamp(dz / TUBE.far, 0, 1);
    if (fade <= 0.05) continue;
    const col = r.depthColour(pal.wall, dz, pal);
    for (let i = 0; i < sides; i += 2) {
      const a0 = (i / sides) * TAU;
      const a1 = ((i + 1) / sides) * TAU;
      const p0 = r.project(a0, rad, z, w.angle);
      if (p0.s < 0) continue;
      const p1 = r.project(a1, rad, z, w.angle);
      if (p1.s < 0) continue;
      const p2 = r.project(a1, rad, z + gap, w.angle);
      if (p2.s < 0) continue;
      const p3 = r.project(a0, rad, z + gap, w.angle);
      if (p3.s < 0) continue;
      ctx.beginPath();
      ctx.moveTo(p0.x, p0.y);
      ctx.lineTo(p1.x, p1.y);
      ctx.lineTo(p2.x, p2.y);
      ctx.lineTo(p3.x, p3.y);
      ctx.closePath();
      ctx.fillStyle = withAlpha(col, alpha * fade);
      ctx.fill();
    }
  }
}

// One bright ring per owned tier, thickness set by how many you own. The ladder
// is literally the furniture you are falling through.
function driveRings(ctx, r, w, st, pal) {
  if (!st) return;
  const sides = TUBE.sides;
  const spacing = 520;
  for (let k = 1; k <= st.tiers; k++) {
    const owned = st.owned[k] | 0;
    if (owned <= 0) continue;
    const rad = TUBE.radius * (1 - 0.055 * k);
    // Rings sit at fixed z in world space and stream past with everything else.
    const z = r.camZ + TUBE.near + ((k * spacing + w.z * 0.5) % (TUBE.far * 0.7));
    const dz = z - r.camZ;
    const fade = 1 - clamp(dz / TUBE.far, 0, 1);
    if (fade <= 0.04) continue;
    ctx.beginPath();
    let ok = true;
    for (let i = 0; i <= sides; i++) {
      const a = ((i % sides) / sides) * TAU;
      const p = r.project(a, rad, z, w.angle);
      if (p.s < 0) { ok = false; break; }
      if (i === 0) ctx.moveTo(p.x, p.y);
      else ctx.lineTo(p.x, p.y);
    }
    if (!ok) continue;
    ctx.closePath();
    ctx.strokeStyle = withAlpha(r.depthColour(pal.edge, dz, pal), 0.35 + fade * 0.5);
    ctx.lineWidth = 1.5 + Math.log10(owned + 1) * 0.8 + fade * 1.5;
    ctx.stroke();
  }
}

// A permanent bright ring at the far end that everything emerges from.
function horizonRing(ctx, r, w, pal) {
  const sides = TUBE.sides;
  const z = r.camZ + TUBE.far * 0.92;
  ctx.beginPath();
  for (let i = 0; i <= sides; i++) {
    const a = ((i % sides) / sides) * TAU;
    const p = r.project(a, TUBE.radius, z, w.angle);
    if (p.s < 0) return;
    if (i === 0) ctx.moveTo(p.x, p.y);
    else ctx.lineTo(p.x, p.y);
  }
  ctx.closePath();
  ctx.strokeStyle = withAlpha(pal.edge, 0.55);
  ctx.lineWidth = 2.5;
  ctx.stroke();
}

// The far rings redrawn inverted through the vanishing point: r' = R^2 / r.
// Unmistakable, and about twenty lines.
function lensing(ctx, r, w, pal) {
  const sides = TUBE.sides;
  const gap = 680;
  const R2 = 240 * 240;
  ctx.strokeStyle = withAlpha(pal.edge, 0.20);
  ctx.lineWidth = 1.2;
  for (let n = 0; n < 6; n++) {
    const z = r.camZ + TUBE.far * (0.55 + n * 0.07);
    ctx.beginPath();
    let ok = true;
    for (let i = 0; i <= sides; i++) {
      const a = ((i % sides) / sides) * TAU;
      const p = r.project(a, TUBE.radius, z, w.angle);
      if (p.s < 0) { ok = false; break; }
      const dx = p.x - r.cx;
      const dy = p.y - r.cy;
      const d2 = Math.max(1, dx * dx + dy * dy);
      const s = R2 / d2;
      const x = r.cx + dx * s;
      const y = r.cy + dy * s;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    if (!ok) continue;
    ctx.closePath();
    ctx.stroke();
  }
}

// A bright arc sweeping the bore wall, with a decaying trail behind it.
function accretion(ctx, r, w, pal) {
  const rad = TUBE.radius * 0.99;
  const head = (w.t * 0.9) % TAU;
  const z = r.camZ + TUBE.near + 900;
  const steps = 14;
  for (let i = 0; i < steps; i++) {
    const a0 = head - i * 0.10;
    const a1 = head - (i + 1) * 0.10;
    const p0 = r.project(a0, rad, z, w.angle);
    if (p0.s < 0) continue;
    const p1 = r.project(a1, rad, z, w.angle);
    if (p1.s < 0) continue;
    ctx.beginPath();
    ctx.moveTo(p0.x, p0.y);
    ctx.lineTo(p1.x, p1.y);
    ctx.strokeStyle = withAlpha(pal.hazard, 0.55 * (1 - i / steps));
    ctx.lineWidth = 4 * (1 - i / steps) + 1;
    ctx.stroke();
  }
}

// A counter-rotating octagon inside the bore, drawn behind everything.
function secondBore(ctx, r, w, pal) {
  const sides = TUBE.sides;
  const rad = TUBE.radius * 0.45;
  const gap = 1360;
  const startZ = Math.floor((r.camZ + TUBE.near) / gap) * gap;
  ctx.strokeStyle = withAlpha(pal.hazard, 0.22);
  ctx.lineWidth = 1.4;
  for (let z = startZ; z < r.camZ + TUBE.far * 0.8; z += gap) {
    ctx.beginPath();
    let ok = true;
    for (let i = 0; i <= sides; i++) {
      // Counter-rotation: the bore spins one way, this spins the other.
      const a = ((i % sides) / sides) * TAU - w.angle * 2;
      const p = r.project(a, rad, z, w.angle);
      if (p.s < 0) { ok = false; break; }
      if (i === 0) ctx.moveTo(p.x, p.y);
      else ctx.lineTo(p.x, p.y);
    }
    if (!ok) continue;
    ctx.closePath();
    ctx.stroke();
  }
}

/** Escort craft, one per DILATE, capped. Drawn with the ship. */
export function drawEscorts(ctx, r, w, st, pal) {
  if (!has(w.band, 'escorts') || !st) return;
  const n = Math.min(6, st.dilates);
  for (let i = 0; i < n; i++) {
    const a = w.angle + ((i + 1) / (n + 1)) * TAU;
    const p = r.project(a, TUBE.radius * 0.80 * (WARP.fovMin / r.fov), w.z + 26, w.angle);
    if (p.s < 0) continue;
    const size = 12 + r.w * 4;
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.fillStyle = withAlpha(pal.edge, 0.75);
    ctx.beginPath();
    ctx.moveTo(0, -size * 0.75);
    ctx.lineTo(size * 0.6, size * 0.5);
    ctx.lineTo(0, size * 0.2);
    ctx.lineTo(-size * 0.6, size * 0.5);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }
}

/** Dust streaks at the vanishing point. Feeds the existing particle pool. */
export function spawnDust(fx, r, w, pal, dt) {
  if (!has(w.band, 'dust')) return;
  const rate = 2 * (1 + 8 * w.warp);
  let n = rate * dt;
  // Fractional carry, so a low rate still produces the occasional mote.
  n = Math.floor(n) + (Math.random() < n % 1 ? 1 : 0);
  for (let i = 0; i < n; i++) {
    const a = Math.random() * TAU;
    const rr = 20 + Math.random() * 50;
    fx.particle(r.cx + Math.cos(a) * rr, r.cy + Math.sin(a) * rr, Math.cos(a) * 260 * (0.4 + w.warp), Math.sin(a) * 260 * (0.4 + w.warp), {
      life: 0.5 + Math.random() * 0.5,
      size: 1 + Math.random() * 2,
      color: pal.edge,
      shape: 3,
      drag: 0.2,
      gravity: 0,
    });
  }
}

/** INVERSION: the doppler poles swap and the whole palette turns over. */
export function inversionActive(band) {
  return has(band, 'inversion');
}
