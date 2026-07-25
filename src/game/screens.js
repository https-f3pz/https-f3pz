// Every non-run screen, drawn on the same canvas as the game.
// Coordinates are the 720-wide virtual space; game.js scales it to the device.

import { VW, UPGRADES, ZONES } from './config.js';
import { outlinedText, roundRect, polygon, withAlpha, clamp } from '../core/draw.js';
import { panel, meter } from '../core/widgets.js';
import { rank, RANKS, ensureMissions, upgradeTier, upgradeCost, todayKey } from './meta.js';

const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
const TAU = Math.PI * 2;

// A slow idle version of the tube, so the menus sit inside the same world.
function bg(ctx, view, t, pal) {
  const g = ctx.createLinearGradient(0, 0, 0, view.vh);
  g.addColorStop(0, pal.fog);
  g.addColorStop(0.45, pal.wall);
  g.addColorStop(1, pal.fog);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, VW, view.vh);

  const cx = VW / 2;
  const cy = view.vh * 0.44;
  ctx.save();
  ctx.globalAlpha = 0.5;
  for (let i = 0; i < 14; i++) {
    // Rings marching outward from the vanishing point.
    const k = ((i / 14) + (t * 0.09) % (1 / 14) * 14) % 1;
    const s = Math.pow(k, 2.2) * 3.2;
    const r = 40 + s * 520;
    ctx.strokeStyle = withAlpha(pal.edge, 0.30 * (1 - k));
    ctx.lineWidth = 1 + (1 - k) * 2;
    ctx.beginPath();
    for (let j = 0; j <= 8; j++) {
      const a = (j / 8) * TAU + t * 0.05;
      const x = cx + Math.cos(a) * r;
      const y = cy + Math.sin(a) * r;
      if (j === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.stroke();
  }
  const gr = ctx.createRadialGradient(cx, cy, 0, cx, cy, 220);
  gr.addColorStop(0, withAlpha(pal.edge, 0.30));
  gr.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = gr;
  ctx.fillRect(0, 0, VW, view.vh);
  ctx.restore();
}

function sigil(ctx, x, y, r, tier, t, color) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(t * 0.3);
  ctx.strokeStyle = color;
  ctx.lineWidth = 3;
  polygon(ctx, 0, 0, r, 8, 0);
  ctx.stroke();
  ctx.globalAlpha = 0.45;
  polygon(ctx, 0, 0, r * 0.66, 8, Math.PI / 8);
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

  sigil(ctx, VW / 2, top + 96, 46, tier, t, pal.edge);
  outlinedText(ctx, r.name, VW / 2, top + 160, {
    size: 20, weight: 900, color: '#FFD34F', outlineWidth: 3, font: FONT,
  });
  outlinedText(ctx, 'REDSHIFT', VW / 2, top + 222, {
    size: 76, weight: 900, color: '#FFFFFF', outlineWidth: 6, font: FONT,
  });
  outlinedText(ctx, 'THE FASTER YOU GO, THE MORE IT LIES', VW / 2, top + 262, {
    size: 18, weight: 700, color: withAlpha('#FFFFFF', 0.45), outlineWidth: 3, font: FONT,
  });
  outlinedText(ctx, `BEST  ${Math.round(save.best || 0).toLocaleString()}`, VW / 2, top + 310, {
    size: 30, weight: 800, color: '#FFD34F', outlineWidth: 4, font: FONT,
  });
  shardChip(ctx, save, VW - 24, top + 30);

  let y = top + 346;
  const reached = ZONES.filter((z) => (save.best || 0) >= z.at);
  const next = ZONES[reached.length];
  if (next) {
    const prev = reached[reached.length - 1];
    outlinedText(ctx, `NEXT: ${next.name} AT ${next.at.toLocaleString()}`, VW / 2, y, {
      size: 17, weight: 700, color: withAlpha('#FFFFFF', 0.5), outlineWidth: 2, font: FONT,
    });
    meter(ctx, 120, y + 16, VW - 240, 7, ((save.best || 0) - prev.at) / (next.at - prev.at), { fg: next.edge });
  } else {
    outlinedText(ctx, 'EVERY ZONE REACHED', VW / 2, y, {
      size: 17, weight: 700, color: '#FFD34F', outlineWidth: 2, font: FONT,
    });
  }
  y += 52;

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
    if (!m.done && m.prog > 0) meter(ctx, VW - 160, y + 15, 110, 6, m.prog / m.goal, { fg: pal.edge });
    ctx.restore();
    y += 44;
  }

  const playY = bottom - 76 - 16 - 104;

  if (playY - y > 170) {
    y += 16;
    const stats = [
      ['RUNS', String(save.runs || 0)],
      ['TOP SPEED', String(Math.round(save.bestSpeed || 0))],
      ['TOTAL', `${Math.round((save.totalDist || 0) / 1000)}k`],
    ];
    const sw = (VW - 56 - 24) / 3;
    stats.forEach((st, i) => {
      const x = 28 + i * (sw + 12);
      roundRect(ctx, x, y, sw, 72, 12);
      ctx.fillStyle = 'rgba(255,255,255,0.05)';
      ctx.fill();
      outlinedText(ctx, st[1], x + sw / 2, y + 28, { size: 26, weight: 900, color: '#FFFFFF', outlineWidth: 0, font: FONT });
      outlinedText(ctx, st[0], x + sw / 2, y + 54, { size: 12, weight: 700, color: withAlpha('#FFFFFF', 0.4), outlineWidth: 0, font: FONT });
    });
    y += 88;
  }

  const hist = save.dists20 || [];
  if (hist.length > 1 && playY - y > 90) {
    y += 12;
    outlinedText(ctx, 'LAST 20 RUNS', 28, y, {
      size: 15, weight: 700, color: withAlpha('#FFFFFF', 0.35), align: 'left', outlineWidth: 0, font: FONT,
    });
    const h = clamp(playY - y - 44, 60, 300);
    const maxD = Math.max(...hist, 1);
    ctx.save();
    ctx.strokeStyle = withAlpha(pal.edge, 0.85);
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

  if (ui.button(ctx, input, dt, 'play', 32, playY, VW - 64, 104, 'GO', {
    textSize: 48, stroke: pal.edge, fill: '#141d3a', fillActive: '#22336b', glow: 22, radius: 26,
  })) {
    g.beginRun({ daily: false });
  }

  const bw = (VW - 64 - 24) / 3;
  const done = save.daily?.date === todayKey() && save.daily?.locked;
  if (ui.button(ctx, input, dt, 'daily', 32, bottom - 76, bw, 60, done ? 'DAILY ✓' : 'DAILY', {
    textSize: 20, sub: done ? `${Math.round(save.daily.dist)} · ${save.daily.streak}d` : 'ONE SEED',
    stroke: done ? '#FFD34F' : '#6a6aa0', fill: '#12142a', radius: 16, pitch: 60,
  })) {
    g.beginRun({ daily: true });
  }
  if (ui.button(ctx, input, dt, 'ship', 32 + bw + 12, bottom - 76, bw, 60, 'SHIP', {
    textSize: 20, sub: 'UPGRADES', stroke: '#6a6aa0', fill: '#12142a', radius: 16, pitch: 60,
  })) {
    g.screen = 'ship';
    g.sfxConfirm();
  }
  if (ui.button(ctx, input, dt, 'settings', 32 + (bw + 12) * 2, bottom - 76, bw, 60, 'SETTINGS', {
    textSize: 20, sub: 'SOUND', stroke: '#6a6aa0', fill: '#12142a', radius: 16, pitch: 60,
  })) {
    g.screen = 'settings';
    g.sfxConfirm();
  }
}

// -------------------------------------------------------------- ship shop

export function drawShip(ctx, g, view, dt) {
  const { ui, input, save, t } = g;
  const pal = g.renderer.palette(0);
  bg(ctx, view, t, pal);
  const top = view.insetTop;
  const bottom = view.vh - view.insetBottom;

  outlinedText(ctx, 'THE SHIP', VW / 2, top + 54, {
    size: 46, weight: 900, color: '#FFFFFF', outlineWidth: 5, font: FONT,
  });
  outlinedText(ctx, 'LENS TRADES SPECTACLE FOR READABILITY', VW / 2, top + 90, {
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
    outlinedText(ctx, u.name, 48, y + 30, { size: 26, weight: 900, color: '#FFFFFF', align: 'left', outlineWidth: 0, font: FONT });
    outlinedText(ctx, u.blurb, 48, y + 56, { size: 16, weight: 700, color: withAlpha('#FFFFFF', 0.45), align: 'left', outlineWidth: 0, font: FONT });
    outlinedText(ctx, u.unit(tier), 48, y + 84, { size: 19, weight: 800, color: pal.edge, align: 'left', outlineWidth: 0, font: FONT });

    for (let i = 0; i < 5; i++) {
      const px = 320 + i * 26;
      roundRect(ctx, px, y + 74, 18, 14, 4);
      ctx.fillStyle = i < tier ? pal.edge : 'rgba(255,255,255,0.14)';
      ctx.fill();
    }

    if (ui.button(ctx, input, dt, `buy${u.id}`, VW - 214, y + 22, 166, 64, maxed ? 'MAX' : `◆ ${cost}`, {
      textSize: 24,
      stroke: maxed ? '#4a4570' : afford ? '#FFD34F' : '#4a4570',
      fill: afford ? '#3a2f10' : '#12142a',
      disabled: maxed || !afford, radius: 14, pitch: 64,
    })) {
      if (g.buy(u.id)) g.sfxConfirm();
    }
    y += 120;
  }

  if (ui.button(ctx, input, dt, 'shipback', 32, bottom - 84, VW - 64, 72, 'BACK', {
    textSize: 30, stroke: pal.edge, fill: '#141d3a', radius: 18,
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
  const row = 92; // >= MIN_TOUCH, so adjacent hit rects can never overlap
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

  outlinedText(ctx, `${save.runs || 0} RUNS · ${Math.round(save.totalDist || 0).toLocaleString()} TOTAL`, VW / 2, y, {
    size: 18, weight: 700, color: withAlpha('#FFFFFF', 0.4), outlineWidth: 2, font: FONT,
  });

  if (g.confirmReset) {
    if (ui.button(ctx, input, dt, 'reset2', 28, bottom - 176, W, 72, 'ERASE EVERYTHING?', {
      textSize: 26, stroke: '#ff2020', fill: '#3a0e14', radius: 18, pitch: 84,
    })) g.wipeSave();
  } else if (ui.button(ctx, input, dt, 'reset', 28, bottom - 176, W, 72, 'RESET PROGRESS', {
    textSize: 22, stroke: '#6a3050', fill: '#1a0f1e', radius: 18, pitch: 84,
  })) {
    g.confirmReset = true;
  }

  if (ui.button(ctx, input, dt, 'back', 28, bottom - 84, W, 72, 'BACK', {
    textSize: 30, stroke: pal.edge, fill: '#141d3a', radius: 18, pitch: 84,
  })) {
    g.confirmReset = false;
    g.screen = 'title';
    g.sfxBack();
  }
}

// ----------------------------------------------------------------- results

export function drawResults(ctx, g, view, dt) {
  const { ui, input, save, t, run } = g;
  const pal = g.renderer.palette(run.dist);
  const top = view.insetTop;
  const bottom = view.vh - view.insetBottom;
  const res = g.result;

  ctx.save();
  ctx.fillStyle = 'rgba(3,4,10,0.88)';
  ctx.fillRect(0, 0, VW, view.vh);
  ctx.restore();

  outlinedText(ctx, res.newBest ? 'FURTHEST YET' : 'HULL SHATTERED', VW / 2, top + 52, {
    size: 24, weight: 800, color: res.newBest ? '#FFD34F' : withAlpha('#FFFFFF', 0.5), outlineWidth: 3, font: FONT,
  });
  outlinedText(ctx, Math.round(g.countUp).toLocaleString(), VW / 2, top + 130, {
    size: 88, weight: 900, color: res.newBest ? '#FFD34F' : '#FFFFFF', outlineWidth: 7, font: FONT,
  });
  outlinedText(ctx, `BEST ${Math.round(save.best || 0).toLocaleString()}`, VW / 2, top + 178, {
    size: 20, weight: 700, color: withAlpha('#FFFFFF', 0.45), outlineWidth: 2, font: FONT,
  });

  ctx.save();
  roundRect(ctx, 28, top + 206, VW - 56, 62, 16);
  ctx.fillStyle = withAlpha(pal.edge, 0.10);
  ctx.fill();
  outlinedText(ctx, g.coach, VW / 2, top + 237, {
    size: g.coach.length > 42 ? 18 : 21, weight: 800, color: pal.edge, outlineWidth: 0, font: FONT,
  });
  ctx.restore();

  let y = top + 288;
  const stats = [
    ['TOP SPEED', String(Math.round(run.topSpeed))],
    ['BEST CHAIN', String(run.bestCombo)],
    ['GRAZES', String(run.grazes)],
    ['GATES', String(run.gates)],
    ['CLIPS', String(run.clips)],
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

  if (ui.button(ctx, input, dt, 'again', 32, againY, VW - 64, 100, 'AGAIN', {
    textSize: 40, stroke: pal.edge, fill: '#141d3a', fillActive: '#22336b', glow: 22, radius: 24,
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
  const pal = g.renderer.palette(g.run ? g.run.dist : 0);
  ctx.save();
  ctx.fillStyle = 'rgba(3,4,10,0.82)';
  ctx.fillRect(0, 0, VW, view.vh);
  ctx.restore();

  const cy = view.vh / 2;
  panel(ctx, 60, cy - 220, VW - 120, 440, { blurGlow: 24, radius: 28 });
  outlinedText(ctx, 'PAUSED', VW / 2, cy - 156, { size: 46, weight: 900, color: '#FFFFFF', outlineWidth: 5, font: FONT });

  if (ui.button(ctx, input, dt, 'resume', 92, cy - 100, VW - 184, 92, 'RESUME', {
    textSize: 32, stroke: pal.edge, fill: '#141d3a', radius: 20, pitch: 104,
  })) g.resume();

  if (ui.button(ctx, input, dt, 'restart', 92, cy + 4, VW - 184, 80, 'RESTART', {
    textSize: 26, stroke: '#6a6aa0', fill: '#12142a', radius: 18, pitch: 92,
  })) {
    // Bank the run first: restarting must never be the one path that throws a
    // record away.
    g.finishRun();
    g.beginRun({ daily: g.isDaily });
  }
  if (ui.button(ctx, input, dt, 'quit', 92, cy + 96, VW - 184, 80, 'QUIT TO MENU', {
    textSize: 26, stroke: '#4a4570', fill: '#101024', radius: 18, pitch: 92,
  })) g.endRunEarly();
}
