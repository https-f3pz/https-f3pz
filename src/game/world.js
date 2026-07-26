// The adapter between the economy and the picture.
//
// render.js never learns that an economy exists. It reads eight fields off a
// plain object — angle, speed, warp, z, dist, hitFlash, grazeFlash, angVel —
// exactly as it did when those came from a ship being flown by a thumb. This
// file is the only place that knows both sides.
//
// Every value it produces is bounded BY CONSTRUCTION rather than by a clamp
// somebody can later delete:
//
//   * warp comes out of a tanh, so it can never reach 1. That matters: at
//     warp === 1 the vignette's inner radius vh*(0.44 - w*0.16) is still
//     positive, but the whole distortion stack was tuned assuming headroom,
//     and createRadialGradient throws IndexSizeError on a negative radius.
//   * speed is an affine function of warp, so it inherits the bound.
//   * z is taken modulo a number divisible by every ring spacing, so the wrap
//     is geometrically invisible and never reaches the magnitude where float64
//     starts quantising ring positions.
//
// And one rule inherited from economy.js: SCALE is a plain float built from
// max() and integer counters ONLY. It must never be a running Big sum — at
// 1e4628 a Big silently stops accepting additions of 1e300, and a visual clock
// that froze that way would do so with no error and no failing test.

import { SPEED, WARP, TUBE, BAND_SPAN } from './config.js';
import * as B from '../core/big.js';
import { PRESTIGE_STEPS } from './config.js';

/** 340 * 2^20 — divisible by every ring spacing on the doubling ladder. */
export const Z_MODULUS = 356515840;

export function makeWorld() {
  return {
    // What render.js reads.
    angle: 0,
    angVel: 0,
    speed: SPEED.min,
    warp: 0,
    z: 0,
    dist: 0,
    hitFlash: 0,
    grazeFlash: 0,
    // What the rest of the game reads.
    scale: 1,
    band: 0,
    cycle: 0, // 0..3, progress through the current collapse in log space
    t: 0,
  };
}

/**
 * A monotone, unbounded-but-slow measure of total progress. Plain float,
 * assembled only from a running max and three integer counters — so it can
 * never regress, and never hits the Big precision floor.
 */
export function scaleOf(st) {
  return 1 + Math.max(0, st.peakLogRate) + 2 * st.collapses + 40 * st.dilates + 250 * st.horizons;
}

export function bandOf(scale) {
  return Math.floor(4 * Math.log10(Math.max(1, scale)));
}

/**
 * Progress through the current collapse, in log space, normalised so that 1.0
 * is roughly where auto-collapse would fire. Because it is normalised, depth
 * 1e10 early looks exactly like depth 1e115 late — which is the entire reason
 * the tunnel stays readable for months.
 */
export function cycleOf(st) {
  const mult = PRESTIGE_STEPS[st.thr.collapse] ?? 2;
  const target = B.mulNum(B.max(st.photons.bank, B.ONE), mult);
  const den = 7 + Math.max(0, B.log10(target)) / 0.32;
  const x = B.log10(B.add(B.ONE, st.depth)) / Math.max(1, den);
  return Math.min(3, Math.max(0, x));
}

/**
 * The permanent warp floor. A veteran's calmest frame is faster than a
 * beginner's fastest, so a reset never reads as a demotion — you snap back to
 * a picture a new player has never seen.
 */
export function floorOf(scale) {
  return 0.10 + 0.52 * (1 - Math.exp(-scale / 900));
}

export function warpFor(scale, cycle) {
  const f = floorOf(scale);
  // tanh is what makes this safe rather than merely careful: strictly < 1.
  return Math.min(0.995, f + (1 - f) * Math.tanh(1.15 * Math.pow(cycle, 1.7)));
}

/**
 * Ring spacing doubles as the bore speeds up, so rings keep arriving at a
 * readable rate instead of strobing. Doubling rather than scaling means the
 * surviving rings stay exactly where they were — every other one simply drops
 * out — so the tube gear-changes instead of appearing to slide.
 */
export function ringGapFor(speed) {
  const want = (speed * 0.34) / TUBE.ringGap;
  const mult = Math.pow(2, Math.max(0, Math.min(2, Math.round(Math.log2(Math.max(1e-6, want))))));
  return TUBE.ringGap * mult;
}

function damp(cur, target, rate, dt) {
  return target + (cur - target) * Math.exp(-rate * dt);
}

/** Advance the picture. `dt` is real seconds. */
export function updateWorld(w, st, dt) {
  w.t += dt;
  w.scale = Math.max(w.scale, scaleOf(st));
  w.band = bandOf(w.scale);
  w.cycle = cycleOf(st);

  const target = warpFor(w.scale, w.cycle);
  w.warp = Math.min(0.995, Math.max(0, damp(w.warp, target, 2.2, dt)));
  w.speed = SPEED.min + SPEED.span * w.warp;

  // A synthetic palette coordinate: whole bands step the palette, and the
  // fractional part inside a band drifts it, so the colour is always moving
  // somewhere without ever depending on an unbounded quantity.
  const f = 4 * Math.log10(Math.max(1, w.scale));
  w.dist = w.band * BAND_SPAN + (f - Math.floor(f)) * BAND_SPAN;

  w.angVel = 0.06 + 0.42 * w.warp + 0.05 * Math.sin(w.t * 0.31);
  w.angle = (w.angle + w.angVel * dt) % (Math.PI * 2);
  w.z = (w.z + w.speed * dt) % Z_MODULUS;

  if (w.hitFlash > 0) w.hitFlash = Math.max(0, w.hitFlash - dt);
  if (w.grazeFlash > 0) w.grazeFlash = Math.max(0, w.grazeFlash - dt);
  return w;
}

/** A purchase landed. */
export function flashBuy(w) {
  w.grazeFlash = 0.22;
}

/** A prestige landed. */
export function flashPrestige(w) {
  w.hitFlash = 0.6;
}
