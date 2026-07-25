// Every non-dive screen, drawn on the same canvas as the game.
// Coordinates are the 720-wide virtual space; game.js scales it to the device.

import { VW, UPGRADES, BIOMES, PX_PER_M } from './config.js';
import { outlinedText, roundRect, polygon, withAlpha, clamp, ease } from '../core/draw.js';
import { panel, meter } from '../core/widgets.js';
import {
  rank, RANKS, ensureMissions, upgradeTier, upgradeCost, todayKey,
} from './meta.js';

const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
const TAU = Math.PI * 2;

function bg(ctx, view, t, pal) {
  const g = ctx.createLinearGradient(0, 0, 0, view.vh);
  g.addColorStop(0, pal.bgTop);
  g.addColorStop(1, pal.bgBottom);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, VW, view.vh);

  // A slow drift of the same rock silhouettes, so the menu feels like it is
  // hanging in the same shaft you are about to dive.
  ctx.save();
  ctx.globalAlpha = 0.5;
  ctx.fillStyle = pal.rock;
  const scroll = (t * 26) % 300;
  for (let i = -1; i < view.vh / 300 + 2; i++) {
    const y = i * 300 + scroll;
    const w = 90 + Math.sin(i * 2.3) * 55;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y + 150);
    ctx.lineTo(0, y + 300);
    ctx.closePath();
    ctx.fill();
    const w2 = 90 + Math.cos(i * 1.7) * 55;
    ctx.beginPath();
    ctx.moveTo(VW, y + 60);
    ctx.lineTo(VW - w2, y + 210);
    ctx.lineTo(VW, y + 360);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
}

function sigil(ctx, x, y, r, tier, t, color) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(t * 0.35);
  ctx.strokeStyle = color;
  ctx.lineWidth = 3;
  polygon(ctx, 0, 0, r, 6, 0);
  ctx.stroke();
  ctx.globalAlpha = 0.45;
  polygon(ctx, 0, 0, r * 0.68, 6, Math.PI / 6);
  ctx.stroke();
  ctx.globalAlpha = 1;
  for (let i = 0; i <= tier; i++) {
    const a = (i / RANKS.length) * TAU - Math.PI / 2;
    ctx.beginPath();
    ctx.arc(Math.cos(a) * r, Math.sin(a) * r, 5, 0, TAU);
    ctx.fillStyle = color;
    ctx.fill();
  }
  ctx.restore();
}

function shardChip(ctx, save, x, y) {
  outlinedText(ctx, `◆ ${Math.floor(save.shards || 0).toLocaleString()}`, x, y, {
    size: 22, weight: 800, color: '#FFD34F', align: 'right', outlineWidth: 3, font: FONT,
  });
}

// ------------------------------------------------------------------- title

export function drawTitle(ctx, g, view, dt) {
  const { ui, input, save, t } = g;
  const pal = g.renderer.palette(0);
  bg(ctx, view, t, pal);

  const top = view.insetTop;
  const bottom = view.vh - view.insetBottom;
  const r = rank(save.best);
  const tier = Math.max(0, RANKS.indexOf(r));

  sigil(ctx, VW / 2, top + 96, 46, tier, t, pal.accent);
  // Rank names are words, not letters — they go under the sigil, not inside it.
  outlinedText(ctx, r.name, VW / 2, top + 162, {
    size: 20, weight: 900, color: '#FFD34F', outlineWidth: 3, font: FONT,
  });
  outlinedText(ctx, 'HOOKFALL', VW / 2, top + 222, {
    size: 78, weight: 900, color: '#FFFFFF', outlineWidth: 6, font: FONT,
  });
  outlinedText(ctx, 'KNOW WHEN TO LET GO', VW / 2, top + 264, {
    size: 19, weight: 700, color: withAlpha('#FFFFFF', 0.45), outlineWidth: 3, font: FONT,
  });

  outlinedText(ctx, `BEST  ${Math.round(save.best || 0).toLocaleString()} m`, VW / 2, top + 312, {
    size: 30, weight: 800, color: '#FFD34F', outlineWidth: 4, font: FONT,
  });
  shardChip(ctx, save, VW - 24, top + 30);

  // Deepest biome reached — the "I've never seen BLACK GLASS" hook.
  let y = top + 348;
  const reached = BIOMES.filter((b) => (save.best || 0) >= b.at);
  const nextB = BIOMES[reached.length];
  if (nextB) {
    const prev = reached[reached.length - 1];
    outlinedText(ctx, `NEXT: ${nextB.name} AT ${nextB.at.toLocaleString()} m`, VW / 2, y, {
      size: 17, weight: 700, color: withAlpha('#FFFFFF', 0.5), outlineWidth: 2, font: FONT,
    });
    meter(ctx, 120, y + 16, VW - 240, 7, ((save.best || 0) - prev.at) / (nextB.at - prev.at), { fg: nextB.accent });
  } else {
    outlinedText(ctx, 'EVERY BIOME REACHED', VW / 2, y, {
      size: 17, weight: 700, color: '#FFD34F', outlineWidth: 2, font: FONT,
    });
  }
  y += 52;

  // ---- missions
  const missions = ensureMissions(save);
  outlinedText(ctx, 'MISSIONS', 28, y, {
    size: 18, weight: 800, color: withAlpha('#FFFFFF', 0.45), align: 'left', outlineWidth: 2, font: FONT,
  });
  y += 18;
  for (const m of missions) {
    ctx.save();
    ctx.globalAlpha = m.done ? 1 : 0.78 + 0.22 * Math.sin(t * 2 + m.text.length);
    roundRect(ctx, 28, y, VW - 56, 36, 10);
    ctx.fillStyle = m.done ? 'rgba(255,211,79,0.14)' : 'rgba(255,255,255,0.05)';
    ctx.fill();
    outlinedText(ctx, (m.done ? '✓ ' : '') + m.text, 44, y + 18, {
      size: 17, weight: 700, color: m.done ? '#FFD34F' : withAlpha('#FFFFFF', 0.6),
      align: 'left', outlineWidth: 0, font: FONT,
    });
    if (!m.done && m.prog > 0) meter(ctx, VW - 160, y + 15, 110, 6, m.prog / m.goal, { fg: pal.accent });
    ctx.restore();
    y += 44;
  }

  const playY = bottom - 76 - 16 - 104;

  // ---- lifetime stats
  if (playY - y > 160) {
    y += 16;
    const stats = [
      ['DIVES', String(save.runs || 0)],
      ['GEMS', String(save.gems || 0)],
      ['TOTAL', `${Math.round((save.totalDepth || 0) / 1000)}k m`],
    ];
    const sw = (VW - 56 - 24) / 3;
    stats.forEach((st, i) => {
      const x = 28 + i * (sw + 12);
      roundRect(ctx, x, y, sw, 72, 12);
      ctx.fillStyle = 'rgba(255,255,255,0.05)';
      ctx.fill();
      outlinedText(ctx, st[1], x + sw / 2, y + 28, {
        size: 28, weight: 900, color: '#FFFFFF', outlineWidth: 0, font: FONT,
      });
      outlinedText(ctx, st[0], x + sw / 2, y + 54, {
        size: 13, weight: 700, color: withAlpha('#FFFFFF', 0.4), outlineWidth: 0, font: FONT,
      });
    });
    y += 88;
  }

  // ---- depth history, expanded to absorb whatever height is left
  const hist = save.depths20 || [];
  if (hist.length > 1 && playY - y > 90) {
    y += 12;
    outlinedText(ctx, 'LAST 20 DIVES', 28, y, {
      size: 15, weight: 700, color: withAlpha('#FFFFFF', 0.35), align: 'left', outlineWidth: 0, font: FONT,
    });
    const h = clamp(playY - y - 44, 60, 300);
    const maxD = Math.max(...hist, 1);
    ctx.save();
    ctx.strokeStyle = withAlpha(pal.accent, 0.85);
    ctx.lineWidth = 3;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    hist.forEach((v, i) => {
      const x = 28 + (i / (hist.length - 1)) * (VW - 56);
      const yy = y + 16 + h - (v / maxD) * h;
      if (i === 0) ctx.moveTo(x, yy);
      else ctx.lineTo(x, yy);
    });
    ctx.stroke();
    ctx.restore();
  }

  // ---- actions
  if (ui.button(ctx, input, dt, 'play', 32, playY, VW - 64, 104, 'DIVE', {
    textSize: 46, stroke: pal.accent, fill: '#141d3a', fillActive: '#22336b', glow: 22, radius: 26,
  })) {
    g.beginRun({ daily: false });
  }

  const bw = (VW - 64 - 24) / 3;
  const dailyDone = save.daily?.date === todayKey() && save.daily?.locked;
  if (ui.button(ctx, input, dt, 'daily', 32, bottom - 76, bw, 60, dailyDone ? 'DAILY ✓' : 'DAILY', {
    textSize: 20, sub: dailyDone ? `${Math.round(save.daily.depth)} m · ${save.daily.streak}d` : 'ONE SEED',
    stroke: dailyDone ? '#FFD34F' : '#6a6aa0', fill: '#12142a', radius: 16, pitch: 60,
  })) {
    g.beginRun({ daily: true });
  }
  if (ui.button(ctx, input, dt, 'hook', 32 + bw + 12, bottom - 76, bw, 60, 'HOOK', {
    textSize: 20, sub: 'UPGRADES', stroke: '#6a6aa0', fill: '#12142a', radius: 16, pitch: 60,
  })) {
    g.screen = 'hook';
    g.sfxConfirm();
  }
  if (ui.button(ctx, input, dt, 'settings', 32 + (bw + 12) * 2, bottom - 76, bw, 60, 'SETTINGS', {
    textSize: 20, sub: 'SOUND', stroke: '#6a6aa0', fill: '#12142a', radius: 16, pitch: 60,
  })) {
    g.screen = 'settings';
    g.sfxConfirm();
  }
}

// -------------------------------------------------------------- hook shop

export function drawHook(ctx, g, view, dt) {
  const { ui, input, save, t } = g;
  const pal = g.renderer.palette(0);
  bg(ctx, view, t, pal);
  const top = view.insetTop;
  const bottom = view.vh - view.insetBottom;

  outlinedText(ctx, 'THE HOOK', VW / 2, top + 54, {
    size: 46, weight: 900, color: '#FFFFFF', outlineWidth: 5, font: FONT,
  });
  outlinedText(ctx, 'UPGRADES CHANGE YOUR STYLE, NOT YOUR CEILING', VW / 2, top + 90, {
    size: 15, weight: 700, color: withAlpha('#FFFFFF', 0.4), outlineWidth: 2, font: FONT,
  });
  shardChip(ctx, save, VW - 24, top + 30);

  let y = top + 128;
  for (const u of UPGRADES) {
    const tier = upgradeTier(save, u.id);
    const cost = upgradeCost(save, u.id);
    const maxed = cost == null;
    const afford = !maxed && (save.shards || 0) >= cost;

    roundRect(ctx, 28, y, VW - 56, 108, 16);
    ctx.fillStyle = 'rgba(255,255,255,0.05)';
    ctx.fill();

    outlinedText(ctx, u.name, 48, y + 30, {
      size: 26, weight: 900, color: '#FFFFFF', align: 'left', outlineWidth: 0, font: FONT,
    });
    outlinedText(ctx, u.blurb, 48, y + 56, {
      size: 16, weight: 700, color: withAlpha('#FFFFFF', 0.45), align: 'left', outlineWidth: 0, font: FONT,
    });
    outlinedText(ctx, u.unit(tier), 48, y + 84, {
      size: 20, weight: 800, color: pal.accent, align: 'left', outlineWidth: 0, font: FONT,
    });

    // Tier pips.
    for (let i = 0; i < 5; i++) {
      const px = 300 + i * 26;
      roundRect(ctx, px, y + 74, 18, 14, 4);
      ctx.fillStyle = i < tier ? pal.accent : 'rgba(255,255,255,0.14)';
      ctx.fill();
    }

    if (ui.button(ctx, input, dt, `buy${u.id}`, VW - 214, y + 22, 166, 64,
      maxed ? 'MAX' : `◆ ${cost}`, {
        textSize: 24,
        stroke: maxed ? '#4a4570' : afford ? '#FFD34F' : '#4a4570',
        fill: afford ? '#3a2f10' : '#12142a',
        disabled: maxed || !afford,
        radius: 14,
        pitch: 64,
      })) {
      if (g.buy(u.id)) g.sfxConfirm();
    }
    y += 120;
  }

  if (ui.button(ctx, input, dt, 'hookback', 32, bottom - 84, VW - 64, 72, 'BACK', {
    textSize: 30, stroke: pal.accent, fill: '#141d3a', radius: 18,
  })) {
    g.screen = 'title';
    g.sfxBack();
  }
}

// ---------------------------------------------------------------- settings

export function drawSettings(ctx, g, view, dt) {
  const { ui, input, save, t } = g;
  const pal = g.renderer.palette(0);
  bg(ctx, view, t, pal);
  const top = view.insetTop;
  const bottom = view.vh - view.insetBottom;

  outlinedText(ctx, 'SETTINGS', VW / 2, top + 54, {
    size: 46, weight: 900, color: '#FFFFFF', outlineWidth: 5, font: FONT,
  });

  let y = top + 110;
  const row = 92; // >= MIN_TOUCH so adjacent hit rects can never overlap
  const W = VW - 56;
  const s = save.settings;

  const toggleRow = (key, label, get, set) => {
    if (ui.toggle(ctx, input, dt, key, 28, y, W, 74, label, get(), { radius: 18, pitch: row, textSize: 26 })) {
      set(!get());
      g.applySettings();
      g.sfxConfirm();
    }
    y += row;
  };

  toggleRow('t_sound', 'SOUND', () => s.sound, (v) => (s.sound = v));
  toggleRow('t_music', 'MUSIC', () => s.music, (v) => (s.music = v));
  toggleRow('t_haptics', 'HAPTICS', () => s.haptics, (v) => (s.haptics = v));
  toggleRow('t_glow', 'REDUCE FLASHING', () => s.reduceGlow, (v) => (s.reduceGlow = v));

  const labels = { 1: 'FULL', 0.5: 'HALF', 0.25: 'MINIMAL', 0: 'OFF' };
  const order = [1, 0.5, 0.25, 0];
  if (ui.button(ctx, input, dt, 'shake', 28, y, W, 74, 'SCREEN SHAKE', {
    align: 'left', textSize: 26, sub: labels[s.reduceShake] ?? 'FULL', radius: 18, stroke: '#6a6aa0', pitch: row,
  })) {
    s.reduceShake = order[(order.indexOf(s.reduceShake) + 1) % order.length];
    g.applySettings();
    g.sfxConfirm();
  }
  y += row + 20;

  outlinedText(ctx, `${save.runs || 0} DIVES · ${Math.round(save.totalDepth || 0).toLocaleString()} m TOTAL`, VW / 2, y, {
    size: 18, weight: 700, color: withAlpha('#FFFFFF', 0.4), outlineWidth: 2, font: FONT,
  });

  if (g.confirmReset) {
    if (ui.button(ctx, input, dt, 'reset2', 28, bottom - 176, W, 72, 'ERASE EVERYTHING?', {
      textSize: 26, stroke: '#ff2020', fill: '#3a0e14', radius: 18, pitch: 84,
    })) {
      g.wipeSave();
    }
  } else if (ui.button(ctx, input, dt, 'reset', 28, bottom - 176, W, 72, 'RESET PROGRESS', {
    textSize: 22, stroke: '#6a3050', fill: '#1a0f1e', radius: 18, pitch: 84,
  })) {
    g.confirmReset = true;
  }

  if (ui.button(ctx, input, dt, 'back', 28, bottom - 84, W, 72, 'BACK', {
    textSize: 30, stroke: pal.accent, fill: '#141d3a', radius: 18, pitch: 84,
  })) {
    g.confirmReset = false;
    g.screen = 'title';
    g.sfxBack();
  }
}

// ----------------------------------------------------------------- results

export function drawResults(ctx, g, view, dt) {
  const { ui, input, save, t, run } = g;
  const pal = g.renderer.palette(run.depth);
  const top = view.insetTop;
  const bottom = view.vh - view.insetBottom;
  const res = g.result;

  ctx.save();
  ctx.fillStyle = 'rgba(4,4,12,0.88)';
  ctx.fillRect(0, 0, VW, view.vh);
  ctx.restore();

  const isBest = res.newBest;
  outlinedText(ctx, isBest ? 'DEEPEST YET' : run.deathCause === 'collapse' ? 'THE COLLAPSE TOOK YOU' : 'YOU HIT SOMETHING',
    VW / 2, top + 52, {
      size: 24, weight: 800, color: isBest ? '#FFD34F' : withAlpha('#FFFFFF', 0.5), outlineWidth: 3, font: FONT,
    });
  outlinedText(ctx, `${Math.round(g.countUp).toLocaleString()}`, VW / 2, top + 132, {
    size: 92, weight: 900, color: isBest ? '#FFD34F' : '#FFFFFF', outlineWidth: 7, font: FONT,
  });
  outlinedText(ctx, 'METRES', VW / 2, top + 180, {
    size: 20, weight: 800, color: withAlpha('#FFFFFF', 0.4), outlineWidth: 3, font: FONT,
  });
  outlinedText(ctx, `BEST ${Math.round(save.best || 0).toLocaleString()} m`, VW / 2, top + 212, {
    size: 20, weight: 700, color: withAlpha('#FFFFFF', 0.45), outlineWidth: 2, font: FONT,
  });

  // The coaching line.
  ctx.save();
  roundRect(ctx, 28, top + 240, VW - 56, 62, 16);
  ctx.fillStyle = withAlpha(pal.accent, 0.10);
  ctx.fill();
  outlinedText(ctx, g.coach, VW / 2, top + 271, {
    size: g.coach.length > 42 ? 18 : 21, weight: 800, color: pal.accent, outlineWidth: 0, font: FONT,
  });
  ctx.restore();

  // Stats.
  let y = top + 322;
  const stats = [
    ['SCORE', Math.round(run.score).toLocaleString()],
    ['BEST CHAIN', String(run.bestCombo)],
    ['WHIPCRACKS', String(run.whipcracks)],
    ['GEMS', String(run.gems)],
    ['TOP SPEED', `${Math.round(run.topSpeed)}`],
    ['SHARDS', `◆ ${res.shardsEarned}`],
  ];
  stats.forEach((st, i) => {
    const col = i % 3;
    const rowI = Math.floor(i / 3);
    const w = (VW - 56 - 24) / 3;
    const x = 28 + col * (w + 12);
    const yy = y + rowI * 82;
    roundRect(ctx, x, yy, w, 70, 12);
    ctx.fillStyle = 'rgba(255,255,255,0.05)';
    ctx.fill();
    outlinedText(ctx, st[1], x + w / 2, yy + 28, { size: 26, weight: 900, color: '#FFFFFF', outlineWidth: 0, font: FONT });
    outlinedText(ctx, st[0], x + w / 2, yy + 54, { size: 13, weight: 700, color: withAlpha('#FFFFFF', 0.4), outlineWidth: 0, font: FONT });
  });
  y += 178;

  const againY = bottom - 190;
  const rewards = res.missionsDone.map((m) => `MISSION · ${m.text}`);
  const room = Math.max(0, Math.floor((againY - 10 - y) / 30));
  for (const rw of rewards.slice(0, room)) {
    ctx.save();
    ctx.globalAlpha = 0.6 + 0.4 * Math.sin(t * 4);
    outlinedText(ctx, rw, VW / 2, y + 14, { size: 18, weight: 800, color: '#FFD34F', outlineWidth: 2, font: FONT });
    ctx.restore();
    y += 30;
  }

  if (ui.button(ctx, input, dt, 'again', 32, againY, VW - 64, 100, 'DIVE AGAIN', {
    textSize: 40, stroke: pal.accent, fill: '#141d3a', fillActive: '#22336b', glow: 22, radius: 24,
  })) {
    g.beginRun({ daily: g.isDaily });
  }
  if (ui.button(ctx, input, dt, 'menu', 32, bottom - 78, VW - 64, 66, 'MENU', {
    textSize: 24, stroke: '#4a4570', fill: '#101024', radius: 16, pitch: 78,
  })) {
    g.screen = 'title';
    g.sfxBack();
  }
}

// ------------------------------------------------------------------- pause

export function drawPause(ctx, g, view, dt) {
  const { ui, input } = g;
  const pal = g.renderer.palette(g.run ? g.run.depth : 0);
  ctx.save();
  ctx.fillStyle = 'rgba(4,4,12,0.82)';
  ctx.fillRect(0, 0, VW, view.vh);
  ctx.restore();

  const cy = view.vh / 2;
  panel(ctx, 60, cy - 220, VW - 120, 440, { blurGlow: 24, radius: 28 });
  outlinedText(ctx, 'PAUSED', VW / 2, cy - 156, {
    size: 46, weight: 900, color: '#FFFFFF', outlineWidth: 5, font: FONT,
  });

  if (ui.button(ctx, input, dt, 'resume', 92, cy - 100, VW - 184, 92, 'RESUME', {
    textSize: 32, stroke: pal.accent, fill: '#141d3a', radius: 20, pitch: 104,
  })) {
    g.resume();
  }
  if (ui.button(ctx, input, dt, 'restart', 92, cy + 4, VW - 184, 80, 'RESTART', {
    textSize: 26, stroke: '#6a6aa0', fill: '#12142a', radius: 18, pitch: 92,
  })) {
    // Bank the dive first — restarting must never be the one path that
    // silently throws a record away.
    g.finishRun();
    g.beginRun({ daily: g.isDaily });
  }
  if (ui.button(ctx, input, dt, 'quit', 92, cy + 96, VW - 184, 80, 'QUIT TO MENU', {
    textSize: 26, stroke: '#4a4570', fill: '#101024', radius: 18, pitch: 92,
  })) {
    g.endRunEarly();
  }
}
