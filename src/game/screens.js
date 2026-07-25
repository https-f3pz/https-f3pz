// Every non-gameplay screen, drawn on the same canvas as the game.
//
// Layout is written against the 360-wide logical space and a worst case of
// 560 logical pixels tall, so nothing is ever pushed off a small phone.

import { VW, C, CORES, MARKS, PRESSURE, MUTATORS } from './config.js';
import { outlinedText, roundRect, polygon, star, withAlpha, clamp, lerp, ease } from '../core/draw.js';
import { panel, meter } from '../core/widgets.js';
import { rank, nextRank, coachingLine, ensureMissions, coreUnlocked, pressureUnlocked, todayKey } from './meta.js';
import { heatColor } from './render.js';

const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
const TAU = Math.PI * 2;

function bg(ctx, view, t) {
  ctx.fillStyle = C.ink;
  ctx.fillRect(0, 0, VW, view.vh);
  const scroll = (t * 90) % 44;
  ctx.save();
  ctx.strokeStyle = 'rgba(90,140,200,0.10)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let y = -44 + scroll; y < view.vh; y += 44) {
    ctx.moveTo(0, Math.round(y) + 0.5);
    ctx.lineTo(VW, Math.round(y) + 0.5);
  }
  for (let x = 0; x <= VW; x += 44) {
    ctx.moveTo(x + 0.5, 0);
    ctx.lineTo(x + 0.5, view.vh);
  }
  ctx.stroke();
  ctx.restore();
}

// The rank sigil: a procedural mark that visibly grows with the player.
function sigil(ctx, x, y, r, tier, t, color) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(t * 6 * (Math.PI / 180));
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  polygon(ctx, 0, 0, r, 6, 0);
  ctx.stroke();
  ctx.globalAlpha = 0.5;
  polygon(ctx, 0, 0, r * 0.72, 6, Math.PI / 6);
  ctx.stroke();
  ctx.globalAlpha = 1;
  // One point per rank tier earned.
  for (let i = 0; i <= tier; i++) {
    const a = (i / 7) * TAU - Math.PI / 2;
    ctx.beginPath();
    ctx.arc(Math.cos(a) * r, Math.sin(a) * r, 2.6, 0, TAU);
    ctx.fillStyle = color;
    ctx.fill();
  }
  ctx.restore();
}

// ------------------------------------------------------------------- title

export function drawTitle(ctx, g, view, dt) {
  const { ui, input, save, t } = g;
  bg(ctx, view, t);

  const top = view.insetTop;
  const bottom = view.vh - view.insetBottom;
  const r = rank(save.best);
  const nr = nextRank(save.best);
  const tier = Math.max(0, ['D', 'C', 'B', 'A', 'S', 'SS', 'SSS'].indexOf(r.name));

  // ---- mark + wordmark
  sigil(ctx, VW / 2, top + 62, 30, tier, t, C.hull);
  outlinedText(ctx, r.name, VW / 2, top + 62, { size: 20, weight: 900, color: C.gold, outlineWidth: 3, font: FONT });
  outlinedText(ctx, 'FLASHOVER', VW / 2, top + 118, { size: 36, weight: 900, color: C.text, outlineWidth: 4, font: FONT });
  outlinedText(ctx, 'BULLETS ARE FUEL', VW / 2, top + 142, { size: 10, weight: 700, color: C.dim, outlineWidth: 2, font: FONT });

  // ---- personal best + progress toward the next rank
  outlinedText(ctx, `BEST ${save.best.toLocaleString()}`, VW / 2, top + 168, {
    size: 15, weight: 800, color: C.gold, outlineWidth: 3, font: FONT,
  });
  if (nr) {
    const prev = r.at;
    meter(ctx, 60, top + 180, VW - 120, 4, (save.best - prev) / (nr.at - prev), { fg: C.gold });
    outlinedText(ctx, `${nr.name} AT ${nr.at.toLocaleString()}`, VW / 2, top + 192, {
      size: 9, weight: 700, color: C.dim, outlineWidth: 2, font: FONT,
    });
  }

  let y = top + 210;

  // ---- core select
  outlinedText(ctx, 'CORE', 16, y + 6, { size: 10, weight: 800, color: C.dim, align: 'left', outlineWidth: 2, font: FONT });
  y += 16;
  const cw = (VW - 32 - 16) / 3;
  CORES.forEach((core, i) => {
    const x = 16 + i * (cw + 8);
    const unlocked = coreUnlocked(save, core);
    const sel = save.core === core.id;
    if (ui.button(ctx, input, dt, `core${core.id}`, x, y, cw, 46, core.name, {
      textSize: 13,
      sub: unlocked ? core.blurb : 'LOCKED',
      stroke: sel ? C.hull : '#4a4570',
      fill: sel ? '#1d2a52' : '#141230',
      disabled: !unlocked,
    })) {
      save.core = core.id;
      g.persist({ core: core.id });
      g.sfxConfirm();
    }
    if (!unlocked) {
      outlinedText(ctx, core.unlock.text, x + cw / 2, y + 58, {
        size: 7.5, weight: 700, color: C.dim, outlineWidth: 2, font: FONT,
      });
    }
  });
  y += 70;

  // ---- pressure tiers
  const maxP = pressureUnlocked(save, save.core);
  if (maxP > 0) {
    outlinedText(ctx, 'PRESSURE', 16, y, { size: 10, weight: 800, color: C.dim, align: 'left', outlineWidth: 2, font: FONT });
    const cur = Math.min(save.pressure ?? 0, maxP);
    outlinedText(ctx, cur > 0 ? PRESSURE[cur - 1].text : 'NONE', VW - 16, y, {
      size: 9, weight: 700, color: cur > 0 ? C.pellet : C.dim, align: 'right', outlineWidth: 2, font: FONT,
    });
    y += 8;
    const pw = (VW - 32 - 5 * 5) / 6;
    for (let i = 0; i <= 5; i++) {
      const x = 16 + i * (pw + 5);
      const locked = i > maxP;
      if (ui.button(ctx, input, dt, `p${i}`, x, y, pw, 26, i === 0 ? '—' : String(i), {
        textSize: 12,
        stroke: cur === i ? C.pellet : '#4a4570',
        fill: cur === i ? '#3a1030' : '#141230',
        disabled: locked,
        radius: 8,
      })) {
        save.pressure = i;
        g.persist({ pressure: i });
        g.sfxConfirm();
      }
    }
    y += 36;
  } else {
    outlinedText(ctx, 'IGNITE ONCE TO UNLOCK PRESSURE TIERS', VW / 2, y + 6, {
      size: 9, weight: 700, color: C.dim, outlineWidth: 2, font: FONT,
    });
    y += 20;
  }

  // ---- missions
  const missions = ensureMissions(save);
  outlinedText(ctx, 'MISSIONS', 16, y, { size: 10, weight: 800, color: C.dim, align: 'left', outlineWidth: 2, font: FONT });
  y += 10;
  for (const m of missions) {
    const breathe = 0.75 + 0.25 * Math.sin(t * 0.6 * TAU + m.text.length);
    ctx.save();
    ctx.globalAlpha = m.done ? 1 : breathe;
    roundRect(ctx, 16, y, VW - 32, 18, 6);
    ctx.fillStyle = m.done ? 'rgba(255,211,79,0.14)' : 'rgba(255,255,255,0.05)';
    ctx.fill();
    outlinedText(ctx, (m.done ? '✓ ' : '') + m.text, 24, y + 9, {
      size: 9, weight: 700, color: m.done ? C.gold : C.dim, align: 'left', outlineWidth: 0, font: FONT,
    });
    if (!m.done && m.prog > 0) {
      meter(ctx, VW - 78, y + 7, 54, 4, m.prog / m.goal, { fg: C.hull });
    }
    ctx.restore();
    y += 22;
  }

  // ---- primary actions, anchored to the thumb
  const playH = 62;
  const playY = bottom - playH - 56;

  // ---- lifetime stats, filling the space between the missions and PLAY.
  // These are the numbers a returning player actually wants to see.
  if (playY - y > 96) {
    // Absorb leftover height here rather than leaving a hole above PLAY.
    // Tall phones get breathing room; short ones stay compact.
    y += 8 + Math.min(46, Math.max(0, (playY - y - 150) * 0.4));
    const stats = [
      ['RUNS', String(save.runs || 0)],
      ['FLASHOVERS', String(save.totalFlashovers || 0)],
      ['IN THE FIRE', `${Math.round(save.timeAboveHeat50 || 0)}s`],
    ];
    const sw = (VW - 32 - 12) / 3;
    stats.forEach((s, i) => {
      const x = 16 + i * (sw + 6);
      roundRect(ctx, x, y, sw, 36, 8);
      ctx.fillStyle = 'rgba(255,255,255,0.05)';
      ctx.fill();
      outlinedText(ctx, s[1], x + sw / 2, y + 14, {
        size: 15, weight: 900, color: C.text, outlineWidth: 0, font: FONT,
      });
      outlinedText(ctx, s[0], x + sw / 2, y + 27, {
        size: 7, weight: 700, color: C.dim, outlineWidth: 0, font: FONT,
      });
    });
    y += 46;

    // Sparkline of the last twenty runs — progress you can see at a glance.
    const hist = save.scores20 || [];
    if (hist.length > 1 && playY - y > 52) {
      outlinedText(ctx, 'LAST 20 RUNS', 16, y, {
        size: 8, weight: 700, color: C.dim, align: 'left', outlineWidth: 0, font: FONT,
      });
      const maxS = Math.max(...hist, 1);
      const h = Math.max(26, Math.min(104, playY - y - 26));
      ctx.save();
      ctx.strokeStyle = withAlpha(C.hull, 0.85);
      ctx.lineWidth = 1.5;
      ctx.lineJoin = 'round';
      ctx.beginPath();
      hist.forEach((v, i) => {
        const x = 16 + (i / (hist.length - 1)) * (VW - 32);
        const yy = y + 8 + h - (v / maxS) * h;
        if (i === 0) ctx.moveTo(x, yy);
        else ctx.lineTo(x, yy);
      });
      ctx.stroke();
      ctx.restore();
    }
  }
  if (ui.button(ctx, input, dt, 'play', 16, playY, VW - 32, playH, 'PLAY', {
    textSize: 26, stroke: C.hull, fill: '#16224a', fillActive: '#22357a', glow: 16, radius: 18,
  })) {
    g.beginRun({ daily: false });
  }

  const dailyDone = save.daily?.date === todayKey();
  const bw = (VW - 32 - 8) / 2;
  if (ui.button(ctx, input, dt, 'daily', 16, bottom - 46, bw, 38, dailyDone ? 'DAILY ✓' : 'DAILY', {
    textSize: 13,
    sub: dailyDone ? `${save.daily.score.toLocaleString()} · ${save.daily.streak}d` : 'ONE SEED, ONE SHOT',
    stroke: dailyDone ? C.gold : '#6a6aa0', fill: '#141230', radius: 12,
  })) {
    g.beginRun({ daily: true });
  }
  if (ui.button(ctx, input, dt, 'settings', 16 + bw + 8, bottom - 46, bw, 38, 'SETTINGS', {
    textSize: 13, sub: 'SOUND · ACCESS', stroke: '#6a6aa0', fill: '#141230', radius: 12,
  })) {
    g.screen = 'settings';
    g.sfxConfirm();
  }
}

// ---------------------------------------------------------------- settings

export function drawSettings(ctx, g, view, dt) {
  const { ui, input, save, t } = g;
  bg(ctx, view, t);
  const top = view.insetTop;
  const bottom = view.vh - view.insetBottom;

  outlinedText(ctx, 'SETTINGS', VW / 2, top + 30, { size: 24, weight: 900, color: C.text, outlineWidth: 4, font: FONT });

  let y = top + 56;
  const row = 42;
  const W = VW - 32;
  const s = save.settings;

  const toggleRow = (key, label, get, set) => {
    if (ui.toggle(ctx, input, dt, key, 16, y, W, 38, label, get(), { radius: 12 })) {
      set(!get());
      g.applySettings();
      g.sfxConfirm();
    }
    y += row;
  };

  toggleRow('t_sound', 'SOUND', () => s.sound, (v) => (s.sound = v));
  toggleRow('t_music', 'MUSIC', () => s.music, (v) => (s.music = v));
  toggleRow('t_haptics', 'HAPTICS', () => s.haptics, (v) => (s.haptics = v));
  toggleRow('t_glow', 'REDUCE GLOW', () => s.reduceGlow, (v) => (s.reduceGlow = v));
  toggleRow('t_hc', 'HIGH CONTRAST', () => s.highContrast, (v) => (s.highContrast = v));

  // Screenshake is a scalar, not a switch — nausea is not binary.
  const shakeLabels = { 1: 'FULL', 0.5: 'HALF', 0.25: 'MINIMAL', 0: 'OFF' };
  const order = [1, 0.5, 0.25, 0];
  if (ui.button(ctx, input, dt, 'shake', 16, y, W, 38, 'SCREEN SHAKE', {
    align: 'left', textSize: 15, sub: shakeLabels[s.reduceShake] ?? 'FULL', radius: 12, stroke: '#6a6aa0',
  })) {
    const i = order.indexOf(s.reduceShake);
    s.reduceShake = order[(i + 1) % order.length];
    g.applySettings();
    g.sfxConfirm();
  }
  y += row;

  if (ui.button(ctx, input, dt, 'ventmode', 16, y, W, 38, 'VENT', {
    align: 'left', textSize: 15,
    sub: s.ventMode === 'lift' ? 'LIFT YOUR THUMB' : 'TAP A SECOND FINGER',
    radius: 12, stroke: '#6a6aa0',
  })) {
    s.ventMode = s.ventMode === 'lift' ? 'secondTap' : 'lift';
    g.applySettings();
    g.sfxConfirm();
  }
  y += row + 6;

  // ---- marks earned
  outlinedText(ctx, 'MARKS', 16, y, { size: 10, weight: 800, color: C.dim, align: 'left', outlineWidth: 2, font: FONT });
  y += 12;
  const per = 4;
  MARKS.forEach((m, i) => {
    const col = i % per;
    const rowI = Math.floor(i / per);
    const w = (VW - 32 - (per - 1) * 6) / per;
    const x = 16 + col * (w + 6);
    const yy = y + rowI * 34;
    const got = !!save.marks[m.id];
    roundRect(ctx, x, yy, w, 30, 8);
    ctx.fillStyle = got ? 'rgba(255,211,79,0.16)' : 'rgba(255,255,255,0.04)';
    ctx.fill();
    ctx.save();
    ctx.globalAlpha = got ? 1 : 0.3;
    star(ctx, x + w / 2, yy + 12, 7, 3.2, 5, -Math.PI / 2 + (got ? t * 0.6 : 0));
    ctx.fillStyle = got ? C.gold : C.dim;
    ctx.fill();
    ctx.restore();
    outlinedText(ctx, m.name.split(' ')[0], x + w / 2, yy + 24, {
      size: 6.5, weight: 800, color: got ? C.gold : C.dim, outlineWidth: 0, font: FONT,
    });
  });
  y += 34 * Math.ceil(MARKS.length / per) + 4;

  if (g.confirmReset) {
    if (ui.button(ctx, input, dt, 'reset2', 16, bottom - 92, VW - 32, 38, 'ERASE EVERYTHING?', {
      textSize: 14, stroke: '#FF2D7A', fill: '#3a0e22', radius: 12,
    })) {
      g.wipeSave();
    }
  } else if (ui.button(ctx, input, dt, 'reset', 16, bottom - 92, VW - 32, 38, 'RESET PROGRESS', {
    textSize: 13, stroke: '#6a3050', fill: '#1a0f1e', radius: 12,
  })) {
    g.confirmReset = true;
  }

  if (ui.button(ctx, input, dt, 'back', 16, bottom - 48, VW - 32, 42, 'BACK', {
    textSize: 18, stroke: C.hull, fill: '#16224a', radius: 14,
  })) {
    g.confirmReset = false;
    g.screen = 'title';
    g.sfxBack();
  }
}

// ------------------------------------------------------------------ draft

export function drawDraft(ctx, g, view, dt) {
  const { ui, input, t } = g;
  const bottom = view.vh - view.insetBottom;

  // The field stays visible behind the cards — you choose in context.
  ctx.save();
  ctx.fillStyle = 'rgba(4,4,14,0.82)';
  ctx.fillRect(0, 0, VW, view.vh);
  ctx.restore();

  const inT = clamp(g.draftT / 0.28, 0, 1);
  const slide = (1 - ease.outCubic(inT)) * 40;

  outlinedText(ctx, 'DRAFT', VW / 2, view.insetTop + 44 - slide, {
    size: 26, weight: 900, color: C.text, outlineWidth: 4, font: FONT,
  });
  outlinedText(ctx, `PICK ONE · ${g.draftIndex + 1}/4`, VW / 2, view.insetTop + 66 - slide, {
    size: 10, weight: 700, color: C.dim, outlineWidth: 2, font: FONT,
  });

  const cards = g.draftCards;
  const cardH = 84;
  const gap = 12;
  const totalH = cards.length * cardH + (cards.length - 1) * gap;
  let y = Math.max(view.insetTop + 88, (view.vh - totalH) / 2 - 10) + slide;

  cards.forEach((m, i) => {
    const owned = g.picks.includes(m.id);
    const x = 16;
    const w = VW - 32;
    const pulse = 0.5 + 0.5 * Math.sin(t * 3 + i);

    if (ui.button(ctx, input, dt, `card${m.id}`, x, y, w, cardH, '', {
      fill: '#141230', fillActive: '#221a4e', stroke: heatColor(30 + i * 30), radius: 16, glow: 8 + pulse * 6,
      disabled: owned,
    })) {
      g.pickMutator(m);
    }

    // Card face: icon, three words, one number. Anything that cannot be felt
    // within four seconds of resuming was cut rather than weakened.
    ctx.save();
    ctx.translate(x + 40, y + cardH / 2);
    ctx.strokeStyle = heatColor(30 + i * 30);
    ctx.lineWidth = 2;
    polygon(ctx, 0, 0, 17, 3 + i, t * 0.6 + i);
    ctx.stroke();
    ctx.globalAlpha = 0.35;
    polygon(ctx, 0, 0, 9, 3 + i, -t * 0.9);
    ctx.stroke();
    ctx.restore();

    outlinedText(ctx, m.name, x + 74, y + 28, {
      size: 16, weight: 900, color: C.text, align: 'left', outlineWidth: 0, font: FONT,
    });
    outlinedText(ctx, m.blurb, x + 74, y + 48, {
      size: 11, weight: 700, color: C.dim, align: 'left', outlineWidth: 0, font: FONT,
    });
    outlinedText(ctx, m.num, x + 74, y + 66, {
      size: 12, weight: 900, color: heatColor(30 + i * 30), align: 'left', outlineWidth: 0, font: FONT,
    });
    y += cardH + gap;
  });

  if (ui.button(ctx, input, dt, 'skip', 16, bottom - 46, VW - 32, 38, 'DECLINE ALL', {
    textSize: 13, stroke: '#4a4570', fill: '#101024', radius: 12,
  })) {
    g.pickMutator(null);
  }
}

// ---------------------------------------------------------------- results

export function drawResults(ctx, g, view, dt) {
  const { ui, input, save, t, run } = g;
  const top = view.insetTop;
  const bottom = view.vh - view.insetBottom;
  const res = g.result;

  // The frozen field stays behind the card: you can see exactly what got you.
  ctx.save();
  ctx.fillStyle = 'rgba(4,4,14,0.86)';
  ctx.fillRect(0, 0, VW, view.vh);
  ctx.restore();

  const shown = Math.round(g.countUp);
  const isBest = res.newBest;

  outlinedText(ctx, isBest ? 'NEW BEST' : 'RUN OVER', VW / 2, top + 34, {
    size: 14, weight: 800, color: isBest ? C.gold : C.dim, outlineWidth: 3, font: FONT,
  });
  outlinedText(ctx, shown.toLocaleString(), VW / 2, top + 76, {
    size: 46, weight: 900, color: isBest ? C.gold : C.text, outlineWidth: 5, font: FONT,
  });
  outlinedText(ctx, `BEST ${save.best.toLocaleString()}`, VW / 2, top + 104, {
    size: 11, weight: 700, color: C.dim, outlineWidth: 2, font: FONT,
  });

  // The coaching line — the actual retry driver.
  const line = g.coach;
  ctx.save();
  roundRect(ctx, 16, top + 118, VW - 32, 34, 10);
  ctx.fillStyle = 'rgba(125,249,255,0.08)';
  ctx.fill();
  outlinedText(ctx, line, VW / 2, top + 135, {
    size: line.length > 34 ? 10 : 12, weight: 800, color: C.hull, outlineWidth: 0, font: FONT,
  });
  ctx.restore();

  // Stat grid.
  let y = top + 164;
  const stats = [
    ['TIME', `${run.time.toFixed(1)}s`],
    ['FLASHOVERS', String(run.flashCount)],
    ['PEAK HEAT', String(Math.round(run.tel.peakHeat))],
    ['VENTS', String(run.ventCount)],
    ['BEST VENT', Math.round(run.bestVent).toLocaleString()],
    ['KILLS', String(run.tel.kills)],
  ];
  stats.forEach((s, i) => {
    const col = i % 3;
    const rowI = Math.floor(i / 3);
    const w = (VW - 32 - 12) / 3;
    const x = 16 + col * (w + 6);
    const yy = y + rowI * 40;
    roundRect(ctx, x, yy, w, 34, 8);
    ctx.fillStyle = 'rgba(255,255,255,0.05)';
    ctx.fill();
    outlinedText(ctx, s[1], x + w / 2, yy + 13, { size: 14, weight: 900, color: C.text, outlineWidth: 0, font: FONT });
    outlinedText(ctx, s[0], x + w / 2, yy + 26, { size: 7, weight: 700, color: C.dim, outlineWidth: 0, font: FONT });
  });
  y += 88;

  // The build you took — the reason this run went the way it did.
  const againY = bottom - 104;
  if (g.picks.length) {
    outlinedText(ctx, 'BUILD', 16, y - 4, {
      size: 8, weight: 700, color: C.dim, align: 'left', outlineWidth: 0, font: FONT,
    });
    y += 6;
    const names = g.picks.map((id) => MUTATORS.find((m) => m.id === id)).filter(Boolean);
    names.forEach((m, i) => {
      const cw = (VW - 32 - 6) / 2;
      const cx = 16 + (i % 2) * (cw + 6);
      const cy = y + Math.floor(i / 2) * 26;
      roundRect(ctx, cx, cy, cw, 22, 7);
      ctx.fillStyle = 'rgba(125,249,255,0.08)';
      ctx.fill();
      outlinedText(ctx, m.name, cx + cw / 2, cy + 11, {
        size: 9, weight: 800, color: C.hull, outlineWidth: 0, font: FONT,
      });
    });
    y += Math.ceil(names.length / 2) * 26 + 8;
  }

  // Sparkline of the last 20 runs — progress you can see.
  const hist = save.scores20 || [];
  if (hist.length > 1) {
    const maxS = Math.max(...hist, 1);
    const w = VW - 32;
    const h = Math.max(30, Math.min(96, againY - y - 30));
    ctx.save();
    outlinedText(ctx, 'LAST 20 RUNS', 16, y - 4, {
      size: 8, weight: 700, color: C.dim, align: 'left', outlineWidth: 0, font: FONT,
    });
    ctx.strokeStyle = withAlpha(C.hull, 0.8);
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    hist.forEach((v, i) => {
      const x = 16 + (i / (hist.length - 1)) * w;
      const yy = y + h - (v / maxS) * h;
      if (i === 0) ctx.moveTo(x, yy);
      else ctx.lineTo(x, yy);
    });
    ctx.stroke();
    ctx.restore();
    y += h + 12;
  }

  // Anything unlocked this run gets its own moment.
  const rewards = [
    ...res.unlocked.map((c) => `CORE UNLOCKED · ${c.name}`),
    ...res.marks.map((m) => `MARK · ${m.name}`),
    ...res.missionsDone.map((m) => `MISSION · ${m.text}`),
  ];
  for (const r of rewards.slice(0, 3)) {
    ctx.save();
    ctx.globalAlpha = 0.6 + 0.4 * Math.sin(t * 4);
    outlinedText(ctx, r, VW / 2, y + 8, { size: 10, weight: 800, color: C.gold, outlineWidth: 2, font: FONT });
    ctx.restore();
    y += 16;
  }

  // AGAIN sits under the thumb. Tap to playing in well under 400ms.
  if (ui.button(ctx, input, dt, 'again', 16, bottom - 104, VW - 32, 56, 'AGAIN', {
    textSize: 24, stroke: C.hull, fill: '#16224a', fillActive: '#22357a', glow: 16, radius: 18,
  })) {
    g.beginRun({ daily: g.isDaily });
  }
  if (ui.button(ctx, input, dt, 'menu', 16, bottom - 42, VW - 32, 36, 'MENU', {
    textSize: 14, stroke: '#4a4570', fill: '#101024', radius: 12,
  })) {
    g.screen = 'title';
    g.sfxBack();
  }
}

// ------------------------------------------------------------------ pause

export function drawPause(ctx, g, view, dt) {
  const { ui, input } = g;
  ctx.save();
  ctx.fillStyle = 'rgba(4,4,14,0.8)';
  ctx.fillRect(0, 0, VW, view.vh);
  ctx.restore();

  const cy = view.vh / 2;
  panel(ctx, 30, cy - 110, VW - 60, 220, { blurGlow: 20 });
  outlinedText(ctx, 'PAUSED', VW / 2, cy - 78, { size: 24, weight: 900, color: C.text, outlineWidth: 4, font: FONT });

  if (ui.button(ctx, input, dt, 'resume', 46, cy - 50, VW - 92, 48, 'RESUME', {
    textSize: 18, stroke: C.hull, fill: '#16224a', radius: 14,
  })) {
    g.resume();
  }
  if (ui.button(ctx, input, dt, 'restart', 46, cy + 6, VW - 92, 40, 'RESTART', {
    textSize: 15, stroke: '#6a6aa0', fill: '#141230', radius: 12,
  })) {
    g.beginRun({ daily: g.isDaily });
  }
  if (ui.button(ctx, input, dt, 'quit', 46, cy + 52, VW - 92, 40, 'QUIT TO MENU', {
    textSize: 15, stroke: '#4a4570', fill: '#101024', radius: 12,
  })) {
    g.endRunEarly();
  }
}
