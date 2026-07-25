// The in-run HUD.
//
// Design constraint from the spec: the gauge, the ring and the palette must
// carry 100% of the heat information, because the game has to be completely
// playable with the sound off. Nothing here is decorative.

import { VW, C, HEAT } from './config.js';
import { outlinedText, roundRect, withAlpha, clamp, lerp } from '../core/draw.js';
import { heatColor } from './render.js';

const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

export function drawHud(ctx, run, view, opt, t) {
  const top = view.insetTop;
  const heat = run.heat;
  const k = heat / 100;
  const gold = opt.newBestLive;

  // ---- score. Its drop shadow literally overheats as the run does.
  const score = Math.round(run.displayScore ?? run.score);
  ctx.save();
  // The readout visibly overheats with the run — but not in high contrast,
  // where a magenta ghost behind white text is exactly the wrong thing.
  const shadow = opt.highContrast ? 0 : lerp(0, 3, k);
  if (shadow > 0.1) {
    ctx.font = `900 34px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = withAlpha(C.pellet, 0.85);
    ctx.fillText(String(score), VW / 2 + shadow, top + 22 + shadow);
  }
  ctx.restore();
  outlinedText(ctx, String(score), VW / 2, top + 22, {
    size: 34, weight: 900, color: gold ? C.gold : C.text, outlineWidth: 3, font: FONT,
  });

  // ---- best / time flanking the score
  outlinedText(ctx, `BEST ${Math.round(run.bestKnown)}`, 34, top + 14, {
    size: 10, weight: 700, color: gold ? C.gold : C.dim, align: 'left', outlineWidth: 2, font: FONT,
  });
  outlinedText(ctx, `${run.time.toFixed(1)}s`, VW - 14, top + 14, {
    size: 10, weight: 700, color: C.dim, align: 'right', outlineWidth: 2, font: FONT,
  });

  // ---- heat gauge
  const gx = 40;
  const gw = VW - 80;
  const gy = top + 44;
  const gh = 9 + (run.gaugePop ?? 0);

  roundRect(ctx, gx, gy, gw, gh, gh / 2);
  ctx.fillStyle = 'rgba(255,255,255,0.10)';
  ctx.fill();

  const fillW = gw * clamp(heat / run.s.flashAt, 0, 1);
  if (fillW > 1) {
    ctx.save();
    roundRect(ctx, gx, gy, gw, gh, gh / 2);
    ctx.clip();
    ctx.fillStyle = opt.highContrast ? '#FFFFFF' : heatColor(heat);
    ctx.fillRect(gx, gy, fillW, gh);
    ctx.restore();
  }

  // Multiplier tier ticks, so the next rung is always visible.
  ctx.save();
  ctx.strokeStyle = 'rgba(0,0,0,0.5)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let h = run.s.multStep; h < run.s.flashAt; h += run.s.multStep) {
    const x = gx + gw * (h / run.s.flashAt);
    ctx.moveTo(x, gy);
    ctx.lineTo(x, gy + gh);
  }
  ctx.stroke();
  ctx.restore();

  // VENT ARMED marker — you can always see the gun is loaded.
  const armX = gx + gw * (HEAT.ventGate / run.s.flashAt);
  const armed = run.heat >= HEAT.ventGate;
  ctx.save();
  ctx.globalAlpha = armed ? 0.6 + 0.4 * Math.sin(t * 8) : 0.35;
  ctx.fillStyle = armed ? '#FFFFFF' : C.dim;
  ctx.beginPath();
  ctx.moveTo(armX, gy - 3);
  ctx.lineTo(armX - 4, gy - 9);
  ctx.lineTo(armX + 4, gy - 9);
  ctx.closePath();
  ctx.fill();
  ctx.restore();

  // ---- multiplier
  outlinedText(ctx, `${run.mult}×`, gx - 6, gy + gh / 2, {
    size: 15, weight: 900, color: opt.highContrast ? '#FFFFFF' : heatColor(heat),
    align: 'right', outlineWidth: 3, font: FONT,
  });

  if (run.flashState === 2) {
    outlinedText(ctx, '×3', gx + gw + 6, gy + gh / 2, {
      size: 15, weight: 900, color: C.gold, align: 'left', outlineWidth: 3, font: FONT,
    });
  }

  // ---- big state banners
  if (run.flashState) {
    const pop = run.flashState === 1 ? 1.35 : 1;
    outlinedText(ctx, 'FLASHOVER', VW / 2, view.vh * 0.30, {
      size: 30 * pop, weight: 900, color: '#FFFFFF', outlineWidth: 5, font: FONT,
    });
  } else if (run.sweepT > 0) {
    const kk = 1 - run.sweepT / 0.7;
    outlinedText(ctx, run.sweepName, VW / 2, view.vh * 0.32, {
      size: 34 * lerp(1.3, 1, Math.min(1, kk * 4)), weight: 900,
      color: '#FFFFFF', outlineWidth: 5, font: FONT,
    });
  }

  // ---- one-time contextual tips, shown at the exact moment they apply
  if (run.tip && run.tipT > 0) {
    ctx.save();
    ctx.globalAlpha = clamp(run.tipT, 0, 1);
    outlinedText(ctx, run.tip, VW / 2, view.vh - view.insetBottom - 46, {
      size: 13, weight: 800, color: C.gold, outlineWidth: 3, font: FONT,
    });
    ctx.restore();
  }

  // ---- SECOND SPARK availability: a small, honest promise
  if (!run.sparkUsed) {
    ctx.save();
    ctx.globalAlpha = run.heat >= HEAT.sparkGate ? 0.95 : 0.28;
    outlinedText(ctx, '◆ SPARK', VW - 14, view.vh - view.insetBottom - 16, {
      size: 10, weight: 800, color: run.heat >= HEAT.sparkGate ? C.gold : C.dim,
      align: 'right', outlineWidth: 2, font: FONT,
    });
    ctx.restore();
  }
}
