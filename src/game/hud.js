// The in-dive HUD.
//
// It lives entirely in the top strip: the bottom third of the screen is where
// the thumb goes, and nothing may ever be drawn under it.

import { VW, COLLAPSE, PHYS } from './config.js';
import { outlinedText, roundRect, withAlpha, clamp } from '../core/draw.js';

const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

export function drawHud(ctx, run, view, pal, opt, t) {
  const top = view.insetTop;

  // ---- depth, the headline number
  const depth = Math.round(run.depth);
  outlinedText(ctx, `${depth.toLocaleString()}`, VW / 2, top + 46, {
    size: 66, weight: 900, color: run.passedBest && run.bestKnown > 0 ? '#FFD34F' : '#FFFFFF',
    outlineWidth: 6, font: FONT,
  });
  outlinedText(ctx, 'METRES', VW / 2, top + 84, {
    size: 16, weight: 800, color: withAlpha('#FFFFFF', 0.45), outlineWidth: 3, font: FONT,
  });

  // ---- biome name and score, flanking
  outlinedText(ctx, run.biome.name, 24, top + 26, {
    size: 17, weight: 800, color: pal.accent, align: 'left', outlineWidth: 3, font: FONT,
  });
  outlinedText(ctx, Math.round(run.score).toLocaleString(), VW - 24, top + 26, {
    size: 17, weight: 800, color: withAlpha('#FFFFFF', 0.75), align: 'right', outlineWidth: 3, font: FONT,
  });

  // ---- chain
  if (run.combo > 0) {
    const k = clamp(run.comboT / 2.6, 0, 1);
    const pop = 1 + Math.max(0, 0.5 - (2.6 - run.comboT) * 2);
    outlinedText(ctx, `CHAIN ×${run.combo}`, VW / 2, top + 122, {
      size: 26 * pop, weight: 900, color: '#FFD34F', outlineWidth: 4, font: FONT,
    });
    roundRect(ctx, VW / 2 - 90, top + 138, 180 * k, 5, 3);
    ctx.fillStyle = withAlpha('#FFD34F', 0.85);
    ctx.fill();
    outlinedText(ctx, `×${run.mult.toFixed(2)}`, VW / 2 + 118, top + 122, {
      size: 17, weight: 800, color: withAlpha('#FFD34F', 0.8), align: 'left', outlineWidth: 3, font: FONT,
    });
  }

  // ---- the Collapse: a permanent distance-to-death bar pinned to the top.
  // The thing chasing you must be unmissable at all times or dying to it feels
  // arbitrary rather than earned.
  const gap = run.y - run.collapseY;
  const danger = clamp(1 - gap / COLLAPSE.maxLag, 0, 1);
  const bw = VW - 48;
  roundRect(ctx, 24, top + 158, bw, 8, 4);
  ctx.fillStyle = 'rgba(255,255,255,0.10)';
  ctx.fill();
  const pulse = gap < COLLAPSE.dreadRange && !opt.reduceGlow ? 0.6 + 0.4 * Math.sin(t * 12) : 1;
  ctx.save();
  roundRect(ctx, 24, top + 158, bw, 8, 4);
  ctx.clip();
  ctx.fillStyle = withAlpha('#ff2020', 0.55 + danger * 0.45 * pulse);
  ctx.fillRect(24, top + 158, bw * danger, 8);
  ctx.restore();
  outlinedText(ctx, 'COLLAPSE', 24, top + 152, {
    size: 11, weight: 800, color: withAlpha('#ff6a6a', 0.7 + danger * 0.3), align: 'left', outlineWidth: 2, font: FONT,
  });

  // ---- speed, bottom-left, small: it matters but it is not the score
  const sp = Math.hypot(run.vx, run.vy);
  const spK = clamp(sp / PHYS.maxSpeed, 0, 1);
  outlinedText(ctx, `${Math.round(sp)} px/s`, 24, view.vh - view.insetBottom - 22, {
    size: 15, weight: 800, color: withAlpha(sp > 3400 ? '#FFD34F' : '#FFFFFF', 0.35 + spK * 0.55),
    align: 'left', outlineWidth: 3, font: FONT,
  });

  // ---- one-time tips, at the exact moment they apply
  if (run.tip && run.tipT > 0) {
    ctx.save();
    ctx.globalAlpha = clamp(run.tipT, 0, 1);
    outlinedText(ctx, run.tip, VW / 2, view.vh - view.insetBottom - 74, {
      size: 22, weight: 800, color: '#FFD34F', outlineWidth: 4, font: FONT,
    });
    ctx.restore();
  }

  // ---- big transient banners
  if (run.banner && run.bannerT > 0) {
    const k = 1 - run.bannerT / 1.5;
    ctx.save();
    ctx.globalAlpha = clamp(run.bannerT * 1.4, 0, 1);
    outlinedText(ctx, run.banner, VW / 2, view.vh * 0.30, {
      size: 46 * (1 + Math.max(0, 0.35 - k * 1.6)), weight: 900,
      color: '#FFFFFF', outlineWidth: 6, font: FONT,
    });
    ctx.restore();
  }

  // ---- pause glyph
  ctx.save();
  ctx.globalAlpha = 0.4;
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(24, top + 96, 5, 20);
  ctx.fillRect(35, top + 96, 5, 20);
  ctx.restore();
}
