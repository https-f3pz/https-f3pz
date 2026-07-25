// Rendering.
//
// The look is flat neon-noir silhouette: near-black solids, one accent colour,
// one hazard colour, nothing else — so that at 4200 px/s on a five-inch screen
// the shape language reads instantly.
//
//   CYAN RING = anchor · RED JAGGED = kills you · GOLD DIAMOND = gem
//   BLACK = wall · WHITE = you
//
// shadowBlur is never used; every emissive shape is drawn twice instead (once
// wide and translucent, once solid), which costs two fills and keeps 60fps.

import { VW, PX_PER_M, HAZ, COLLAPSE, halfGap, centreX, biomeBlend } from './config.js';
import { mixHex, withAlpha, clamp, lerp, cachedLinearGradient, cachedRadialGradient } from '../core/draw.js';
import { makeRng } from '../core/rng.js';

const TAU = Math.PI * 2;

// Parallax silhouettes are baked once per 900px segment per layer.
const rockCache = new Map();

function rockPath(layer, seg, amp, step) {
  const key = `${layer}:${seg}`;
  let p = rockCache.get(key);
  if (p) return p;
  const rng = makeRng((seg * 2654435761 + layer * 40503) >>> 0);
  p = new Path2D();
  // Left silhouette.
  p.moveTo(0, 0);
  for (let y = 0; y <= 900; y += step) {
    p.lineTo(amp * rng.range(0.25, 1.0), y);
  }
  p.lineTo(0, 900);
  p.closePath();
  // Right silhouette.
  p.moveTo(VW, 0);
  for (let y = 0; y <= 900; y += step) {
    p.lineTo(VW - amp * rng.range(0.25, 1.0), y);
  }
  p.lineTo(VW, 900);
  p.closePath();
  if (rockCache.size > 220) rockCache.clear();
  rockCache.set(key, p);
  return p;
}

export function clearRockCache() {
  rockCache.clear();
}

export class Renderer {
  constructor() {
    this.t = 0;
    this.chroma = 0;
  }

  palette(metres) {
    const b = biomeBlend(metres);
    const from = b.from;
    const to = b.to;
    const k = Math.round(b.k * 16) / 16;
    return {
      bgTop: mixHex(from.bgTop, to.bgTop, k),
      bgBottom: mixHex(from.bgBottom, to.bgBottom, k),
      accent: mixHex(from.accent, to.accent, k),
      hazard: mixHex(from.hazard, to.hazard, k),
      rock: mixHex(from.rock, to.rock, k),
    };
  }

  // ---------------------------------------------------------------- camera

  camera(run, view) {
    const vh = view.vh;
    // The diver sits high on the screen so most of the viewport is the ground
    // you are about to cover, and lookahead opens it further as you speed up.
    const look = clamp(run.vy * 0.20, -60, 420);
    const y = run.y - vh * 0.30 + look;
    const speedK = clamp((Math.hypot(run.vx, run.vy) - 1000) / 2000, 0, 1);
    return { y, zoom: 1 / (1 + 0.07 * speedK), speedK };
  }

  // ------------------------------------------------------------ background

  background(ctx, run, view, cam, pal, opt) {
    const vh = view.vh;
    ctx.fillStyle = cachedLinearGradient(
      ctx, `bg:${pal.bgTop}${pal.bgBottom}${Math.round(vh)}`,
      0, 0, 0, vh, [[0, pal.bgTop], [1, pal.bgBottom]]
    );
    ctx.fillRect(0, 0, VW, vh);
  }

  // Three parallax layers of jagged rock, each scrolling at its own rate.
  // Drawn into whatever region the caller has clipped to — which is the wall
  // mass, so the walls have visible strata instead of being flat black.
  parallax(ctx, view, cam, pal, opt) {
    if (opt.reduceGlow) return;
    const vh = view.vh;
    // Two layers, not three: clipping each one to the wall silhouette is the
    // single most expensive thing in the frame, and the third layer was worth
    // far less than the ~6ms it cost.
    const layers = opt.quality < 1
      ? [{ f: 0.35, amp: 260, step: 150, alpha: 0.5, tint: 0.2 }]
      : [
        { f: 0.28, amp: 300, step: 150, alpha: 0.55, tint: 0.0 },
        { f: 0.58, amp: 200, step: 100, alpha: 0.5, tint: 0.5 },
      ];
    for (let i = 0; i < layers.length; i++) {
      const l = layers[i];
      const top = cam.y * l.f;
      const s0 = Math.floor(top / 900) - 1;
      const s1 = Math.floor((top + vh) / 900) + 1;
      ctx.save();
      ctx.globalAlpha = l.alpha;
      ctx.fillStyle = mixHex(pal.rock, pal.bgBottom, l.tint);
      for (let s = s0; s <= s1; s++) {
        ctx.save();
        ctx.translate(0, s * 900 - top);
        ctx.fill(rockPath(i, s, l.amp, l.step));
        ctx.restore();
      }
      ctx.restore();
    }
  }

  // Vertical streaks that lengthen with speed: the screen physically opens up
  // as you accelerate, which is the cheapest and most effective speed cue.
  speedLines(ctx, run, view, cam, pal, opt) {
    if (opt.reduceGlow) return;
    const k = cam.speedK;
    if (k < 0.04) return;
    const n = Math.round(k * 26);
    ctx.save();
    ctx.strokeStyle = withAlpha(pal.accent, 0.10 + k * 0.28);
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const seed = (i * 9301 + Math.floor(cam.y / 220) * 49297) % 233280;
      const x = (seed / 233280) * VW;
      const y = ((seed * 7 + this.t * 900 * (0.6 + k)) % (view.vh + 400)) - 200;
      const len = 70 + k * 260;
      ctx.moveTo(x, y);
      ctx.lineTo(x, y + len);
    }
    ctx.stroke();
    ctx.restore();
  }

  // ----------------------------------------------------------------- walls

  walls(ctx, run, view, cam, pal, opt) {
    const top = cam.y - 160;
    const bot = cam.y + view.vh + 160;
    const step = 56;

    const masses = new Path2D();
    masses.moveTo(-60, top - cam.y);
    for (let y = top; y <= bot; y += step) masses.lineTo(centreX(y) - halfGap(y), y - cam.y);
    masses.lineTo(-60, bot - cam.y);
    masses.closePath();
    masses.moveTo(VW + 60, top - cam.y);
    for (let y = top; y <= bot; y += step) masses.lineTo(centreX(y) + halfGap(y), y - cam.y);
    masses.lineTo(VW + 60, bot - cam.y);
    masses.closePath();

    ctx.save();
    ctx.fillStyle = '#04040a';
    ctx.fill(masses);

    // Strata, confined to the rock.
    ctx.save();
    ctx.clip(masses);
    this.parallax(ctx, view, cam, pal, opt);
    ctx.restore();

    // Accent edge: wide-and-faint, then solid. Glow without shadowBlur.
    for (const pass of [{ w: 12, a: 0.20 }, { w: 3.5, a: 1 }]) {
      ctx.strokeStyle = withAlpha(pal.accent, pass.a);
      ctx.lineWidth = pass.w;
      ctx.beginPath();
      for (let y = top; y <= bot; y += step) {
        const x = centreX(y) - halfGap(y);
        if (y === top) ctx.moveTo(x, y - cam.y);
        else ctx.lineTo(x, y - cam.y);
      }
      ctx.stroke();
      ctx.beginPath();
      for (let y = top; y <= bot; y += step) {
        const x = centreX(y) + halfGap(y);
        if (y === top) ctx.moveTo(x, y - cam.y);
        else ctx.lineTo(x, y - cam.y);
      }
      ctx.stroke();
    }
    ctx.restore();
  }

  // --------------------------------------------------------------- content

  world(ctx, run, view, cam, pal, opt) {
    const top = cam.y - 200;
    const bot = cam.y + view.vh + 200;

    // -- best-depth ghost: you physically fly past your own record
    const bestY = run.bestKnown * PX_PER_M;
    if (run.bestKnown > 0 && bestY > top && bestY < bot) {
      const y = bestY - cam.y;
      ctx.save();
      ctx.strokeStyle = withAlpha('#FFD34F', 0.9);
      ctx.lineWidth = 2;
      ctx.setLineDash([14, 10]);
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(VW, y);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = '#FFD34F';
      ctx.font = '800 22px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(`YOUR BEST · ${Math.round(run.bestKnown)} m`, VW / 2, y - 12);
      ctx.restore();
    }

    for (const chunk of run.world.live()) {
      if (chunk.y1 < top || chunk.y0 > bot) continue;

      // -- anchors
      for (const a of chunk.anchors) {
        const y = a.y - cam.y;
        if (y < -80 || y > view.vh + 80) continue;
        const isTarget = a === run.target;
        const isHooked = a === run.anchor;
        const pop = isHooked ? 1 + Math.max(0, 0.8 - run.ropeAge * 4) : 1;
        ctx.save();
        ctx.translate(a.x, y);
        ctx.rotate(this.t * 0.6);
        const r = 17 * pop;
        for (const pass of [{ w: 9, al: isTarget ? 0.35 : 0.14 }, { w: 3, al: isTarget ? 1 : 0.5 }]) {
          ctx.strokeStyle = withAlpha(pal.accent, pass.al);
          ctx.lineWidth = pass.w;
          ctx.beginPath();
          ctx.arc(0, 0, r, 0, TAU);
          ctx.stroke();
        }
        if (isTarget) {
          ctx.strokeStyle = withAlpha(pal.accent, 0.85);
          ctx.lineWidth = 2;
          ctx.beginPath();
          for (let i = 0; i < 4; i++) {
            const ang = (i / 4) * TAU;
            ctx.moveTo(Math.cos(ang) * (r + 8), Math.sin(ang) * (r + 8));
            ctx.lineTo(Math.cos(ang) * (r + 17), Math.sin(ang) * (r + 17));
          }
          ctx.stroke();
        }
        ctx.restore();
      }

      // -- gems
      for (const g of chunk.gems) {
        if (g.taken) continue;
        const y = g.y - cam.y;
        if (y < -60 || y > view.vh + 60) continue;
        ctx.save();
        ctx.translate(g.x, y);
        ctx.rotate(this.t * 1.6);
        for (const pass of [{ s: 1.9, a: 0.25 }, { s: 1, a: 1 }]) {
          ctx.fillStyle = withAlpha('#FFD34F', pass.a);
          ctx.beginPath();
          ctx.moveTo(0, -15 * pass.s);
          ctx.lineTo(11 * pass.s, 0);
          ctx.lineTo(0, 15 * pass.s);
          ctx.lineTo(-11 * pass.s, 0);
          ctx.closePath();
          ctx.fill();
        }
        ctx.restore();
      }

      // -- hazards
      for (const h of chunk.hazards) {
        const y = h.cy - cam.y;
        if (y < -160 || y > view.vh + 160) continue;
        ctx.save();
        ctx.translate(h.cx, y);

        if (h.type === HAZ.SAW || h.type === HAZ.ORBIT) {
          if (h.type === HAZ.ORBIT) {
            // Show the orbit so the risky anchor reads as a decision.
            ctx.save();
            ctx.translate(h.x - h.cx, h.y - h.cy);
            ctx.strokeStyle = withAlpha(pal.hazard, 0.22);
            ctx.lineWidth = 2;
            ctx.setLineDash([8, 12]);
            ctx.beginPath();
            ctx.arc(0, 0, h.orbitR, 0, TAU);
            ctx.stroke();
            ctx.restore();
          }
          ctx.rotate(this.t * h.spin);
          for (const pass of [{ s: 1.35, a: 0.22 }, { s: 1, a: 1 }]) {
            ctx.fillStyle = withAlpha(pal.hazard, pass.a);
            ctx.beginPath();
            const teeth = 9;
            for (let i = 0; i < teeth * 2; i++) {
              const rr = (i % 2 === 0 ? h.r : h.r * 0.66) * pass.s;
              const ang = (i / (teeth * 2)) * TAU;
              const px = Math.cos(ang) * rr;
              const py = Math.sin(ang) * rr;
              if (i === 0) ctx.moveTo(px, py);
              else ctx.lineTo(px, py);
            }
            ctx.closePath();
            ctx.fill();
          }
          ctx.fillStyle = '#04040a';
          ctx.beginPath();
          ctx.arc(0, 0, h.r * 0.30, 0, TAU);
          ctx.fill();
        } else if (h.type === HAZ.CRUSHER) {
          for (const pass of [{ p: 7, a: 0.20 }, { p: 0, a: 1 }]) {
            ctx.fillStyle = withAlpha(pal.hazard, pass.a);
            ctx.fillRect(-h.w / 2 - pass.p, -h.h / 2 - pass.p, h.w + pass.p * 2, h.h + pass.p * 2);
          }
          ctx.save();
          ctx.beginPath();
          ctx.rect(-h.w / 2, -h.h / 2, h.w, h.h);
          ctx.clip();
          ctx.strokeStyle = 'rgba(0,0,0,0.45)';
          ctx.lineWidth = 9;
          ctx.beginPath();
          for (let i = -h.h; i < h.w + h.h; i += 26) {
            ctx.moveTo(-h.w / 2 + i, -h.h / 2);
            ctx.lineTo(-h.w / 2 + i - h.h, h.h / 2);
          }
          ctx.stroke();
          ctx.restore();
        } else if (h.type === HAZ.SPIKE) {
          const dir = -h.side; // teeth point into the shaft
          for (const pass of [{ s: 1.22, a: 0.20 }, { s: 1, a: 1 }]) {
            ctx.fillStyle = withAlpha(pal.hazard, pass.a);
            ctx.beginPath();
            ctx.moveTo(0, (-h.h / 2) * pass.s);
            ctx.lineTo(dir * h.w * pass.s, 0);
            ctx.lineTo(0, (h.h / 2) * pass.s);
            ctx.closePath();
            ctx.fill();
          }
        }
        ctx.restore();
      }
    }
  }

  // ------------------------------------------------------------ the diver

  diver(ctx, run, view, cam, pal, opt) {
    // -- predicted swing arc, drawn before you ever touch the screen
    if (run.arc.length && !run.dead) {
      ctx.save();
      ctx.fillStyle = withAlpha(pal.accent, 0.5);
      for (let i = 0; i < run.arc.length; i += 2) {
        const y = run.arc[i + 1] - cam.y;
        ctx.beginPath();
        ctx.arc(run.arc[i], y, 3, 0, TAU);
        ctx.fill();
      }
      ctx.restore();
    }

    // -- trail ribbon, lengthening and shifting hue with the chain
    if (run.trail.length > 1) {
      ctx.save();
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      const hueShift = Math.min(run.combo, 30) / 30;
      const col = mixHex(pal.accent, '#FFD34F', hueShift);
      for (let i = 0; i < run.trail.length - 1; i++) {
        const a = run.trail[i];
        const b = run.trail[i + 1];
        const k = 1 - i / run.trail.length;
        // Deliberately thinner than the rope: at a glance the player must
        // never confuse where they have been with what they are attached to.
        ctx.strokeStyle = withAlpha(col, 0.10 + k * 0.45);
        ctx.lineWidth = 1.5 + k * 5;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y - cam.y);
        ctx.lineTo(b.x, b.y - cam.y);
        ctx.stroke();
      }
      ctx.restore();
    }

    // -- rope
    if (run.hook !== 0) {
      const ax = run.hook === 1 ? run.hx : run.anchor.x;
      const ay = (run.hook === 1 ? run.hy : run.anchor.y) - cam.y;
      const dy = run.y - cam.y;
      const d = Math.hypot(run.x - ax, run.y - (ay + cam.y));
      ctx.save();
      ctx.strokeStyle = '#FFFFFF';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      if (run.hook === 2 && d < run.L - 6) {
        // Slack rope sags, and snaps straight the frame it goes taut. This is
        // the clearest possible signal of when the pendulum takes over.
        const sag = Math.min(90, (run.L - d) * 0.6);
        ctx.quadraticCurveTo((ax + run.x) / 2, (ay + dy) / 2 + sag, run.x, dy);
      } else {
        ctx.lineTo(run.x, dy);
      }
      ctx.stroke();
      ctx.restore();
    }

    if (run.dead) return;

    // -- the diver: a capsule aligned to its velocity vector
    const ang = Math.atan2(run.vy, run.vx);
    const sp = Math.hypot(run.vx, run.vy);
    const stretch = 1 + clamp(sp / 4200, 0, 1) * 0.9;
    ctx.save();
    ctx.translate(run.x, run.y - cam.y);
    ctx.rotate(ang);
    for (const pass of [{ s: 2.0, a: 0.22 }, { s: 1, a: 1 }]) {
      ctx.fillStyle = withAlpha('#FFFFFF', pass.a);
      ctx.beginPath();
      const w = 16 * stretch * pass.s;
      const h = 9 * pass.s;
      ctx.ellipse(0, 0, w, h, 0, 0, TAU);
      ctx.fill();
    }
    ctx.restore();

    // -- whipcrack chromatic pop
    if (run.whipT > 0 && !opt.reduceGlow) {
      const a = run.whipT / 0.14;
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = a * 0.5;
      ctx.fillStyle = '#ff2b5e';
      ctx.beginPath();
      ctx.arc(run.x + 4, run.y - cam.y, 16, 0, TAU);
      ctx.fill();
      ctx.fillStyle = '#2bd7ff';
      ctx.beginPath();
      ctx.arc(run.x - 4, run.y - cam.y, 16, 0, TAU);
      ctx.fill();
      ctx.restore();
    }
  }

  // -------------------------------------------------------- the Collapse

  collapse(ctx, run, view, cam, pal) {
    const y = run.collapseY - cam.y;
    if (y < -400) return;
    ctx.save();
    // The mass above.
    ctx.fillStyle = '#120206';
    ctx.fillRect(-40, -600, VW + 80, y + 600);

    // Grinding teeth along its face.
    ctx.fillStyle = '#2a0410';
    ctx.beginPath();
    ctx.moveTo(-40, y);
    const w = 46;
    const wob = Math.sin(this.t * 22) * 7;
    for (let x = -40; x < VW + 60; x += w) {
      ctx.lineTo(x + w / 2, y + 30 + ((x / w) % 2 === 0 ? wob : -wob));
      ctx.lineTo(x + w, y);
    }
    ctx.lineTo(VW + 40, -600);
    ctx.lineTo(-40, -600);
    ctx.closePath();
    ctx.fill();

    for (const pass of [{ w: 14, a: 0.30 }, { w: 4, a: 1 }]) {
      ctx.strokeStyle = withAlpha('#ff2020', pass.a);
      ctx.lineWidth = pass.w;
      ctx.beginPath();
      ctx.moveTo(-40, y);
      for (let x = -40; x < VW + 60; x += w) {
        ctx.lineTo(x + w / 2, y + 30 + ((x / w) % 2 === 0 ? wob : -wob));
        ctx.lineTo(x + w, y);
      }
      ctx.stroke();
    }
    ctx.restore();
  }

  // -------------------------------------------------------------- overlays

  overlays(ctx, run, view, cam, pal, opt) {
    const vh = view.vh;
    // Dread: the screen edges bleed red as the Collapse closes.
    const gap = run.y - run.collapseY;
    const dread = clamp(1 - gap / COLLAPSE.dreadRange, 0, 1);
    if (dread > 0.01) {
      const pulse = opt.reduceGlow ? 0.5 : 0.5 + 0.5 * Math.sin(this.t * 12);
      // Quantised so the cache actually hits; createRadialGradient every frame
      // over a full-screen fill is one of the most expensive things here.
      const a = Math.round((0.16 + dread * (0.28 + pulse * 0.16)) * 24) / 24;
      ctx.fillStyle = cachedRadialGradient(
        ctx, `dread:${a}:${Math.round(vh)}`,
        VW / 2, vh / 2, vh * 0.30, vh * 0.72,
        [[0, 'rgba(0,0,0,0)'], [1, withAlpha('#ff2020', a)]]
      );
      ctx.fillRect(0, 0, VW, vh);
    }

    // Speed vignette: tightens as you accelerate.
    if (cam.speedK > 0.02 && !opt.reduceGlow) {
      const q = Math.round(cam.speedK * 12) / 12;
      ctx.fillStyle = cachedRadialGradient(
        ctx, `vig:${q}:${Math.round(vh)}`,
        VW / 2, vh / 2, vh * (0.46 - q * 0.10), vh * 0.78,
        [[0, 'rgba(0,0,0,0)'], [1, `rgba(0,0,0,${(0.20 + q * 0.30).toFixed(3)})`]]
      );
      ctx.fillRect(0, 0, VW, vh);
    }
  }
}
