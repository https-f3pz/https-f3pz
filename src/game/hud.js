// The in-run HUD.
//
// Lives in the top strip only: the lower half of the screen is thumb space and
// nothing may be drawn under it. The speed readout is the most important
// element on screen, because speed is simultaneously the score, the difficulty
// and the amount by which the picture is lying to you.

import { VW, SPEED } from './config.js';
import { outlinedText, roundRect, withAlpha, clamp } from '../core/draw.js';

const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

export function drawHud(ctx, run, view, pal, opt, t) {
  const top = view.insetTop;
  const w = run.warp;

  // ---- distance, the headline
  outlinedText(ctx, Math.round(run.dist).toLocaleString(), VW / 2, top + 44, {
    size: 60, weight: 900, color: run.passedBest && run.bestKnown > 0 ? '#FFD34F' : '#FFFFFF',
    outlineWidth: 6, font: FONT,
  });
  outlinedText(ctx, run.zone.name, VW / 2, top + 80, {
    size: 16, weight: 800, color: pal.edge, outlineWidth: 3, font: FONT,
  });

  // ---- speed bar: the warp meter, and the whole risk/reward loop in one strip
  const bx = 28;
  const bw = VW - 56;
  const by = top + 100;
  roundRect(ctx, bx, by, bw, 12, 6);
  ctx.fillStyle = 'rgba(255,255,255,0.10)';
  ctx.fill();
  const k = clamp((run.speed - SPEED.min) / (SPEED.max - SPEED.min), 0, 1);

  // Where on this bar the hull gives out. The shatter point slides left all
  // run as the hull tires and right again on every graze, so showing it as a
  // moving mark turns the whole risk model into one glanceable gap: how much
  // bar is left between your speed and the red.
  const shatterSpeed = SPEED.start + (run.shatter / Math.max(0.01, run.lens)) * (SPEED.max - SPEED.start);
  const sk = clamp((shatterSpeed - SPEED.min) / (SPEED.max - SPEED.min), 0, 1);
  const critical = w >= run.shatter;

  ctx.save();
  roundRect(ctx, bx, by, bw, 12, 6);
  ctx.clip();
  if (sk < 1) {
    ctx.fillStyle = 'rgba(255,32,32,0.22)';
    ctx.fillRect(bx + bw * sk, by, bw * (1 - sk), 12);
  }
  const g = ctx.createLinearGradient(bx, 0, bx + bw, 0);
  g.addColorStop(0, pal.edge);
  g.addColorStop(0.6, '#FFD34F');
  g.addColorStop(1, '#ff3b6b');
  ctx.fillStyle = g;
  ctx.fillRect(bx, by, bw * k, 12);
  ctx.restore();

  if (sk < 1) {
    ctx.fillStyle = critical ? '#ff2020' : 'rgba(255,255,255,0.75)';
    ctx.fillRect(bx + bw * sk - 1.5, by - 4, 3, 20);
  }
  outlinedText(ctx, `${Math.round(run.speed)}`, bx, by + 30, {
    size: 18, weight: 900, color: '#FFFFFF', align: 'left', outlineWidth: 3, font: FONT,
  });
  // Past the mark, one scrape ends the run — so say so, rather than leaving it
  // as a percentage the player has to interpret.
  outlinedText(ctx, critical ? 'HULL CRITICAL' : `WARP ${Math.round(w * 100)}%`, bx + bw, by + 30, {
    size: 18, weight: 900,
    color: critical ? (Math.floor(t * 8) % 2 ? '#ff2020' : '#ffd34f') : withAlpha('#FFFFFF', 0.6),
    align: 'right', outlineWidth: 3, font: FONT,
  });

  // ---- chain
  if (run.combo > 0) {
    const ck = clamp(run.comboT / 2.4, 0, 1);
    outlinedText(ctx, `×${run.combo}`, VW / 2, top + 156, {
      size: 30, weight: 900, color: '#FFD34F', outlineWidth: 4, font: FONT,
    });
    roundRect(ctx, VW / 2 - 60, top + 172, 120 * ck, 5, 3);
    ctx.fillStyle = withAlpha('#FFD34F', 0.85);
    ctx.fill();
  }

  // ---- transient banner
  if (run.banner && run.bannerT > 0) {
    ctx.save();
    ctx.globalAlpha = clamp(run.bannerT * 1.4, 0, 1);
    outlinedText(ctx, run.banner, VW / 2, view.vh * 0.72, {
      size: 44, weight: 900, color: '#FFFFFF', outlineWidth: 6, font: FONT,
    });
    ctx.restore();
  }

  // ---- one-time tips
  if (run.tip && run.tipT > 0) {
    ctx.save();
    ctx.globalAlpha = clamp(run.tipT, 0, 1);
    outlinedText(ctx, run.tip, VW / 2, view.vh - view.insetBottom - 60, {
      size: 22, weight: 800, color: '#FFD34F', outlineWidth: 4, font: FONT,
    });
    ctx.restore();
  }

  // ---- pause glyph, top-left, clear of the play surface
  ctx.save();
  ctx.globalAlpha = 0.4;
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(24, top + 12, 5, 20);
  ctx.fillRect(35, top + 12, 5, 20);
  ctx.restore();
}
