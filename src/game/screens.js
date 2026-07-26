// Every screen, drawn on the same canvas as the tunnel.
// Coordinates are the 720-wide virtual space; game.js scales it to the device.
//
// The tunnel is always live underneath, on every screen — game.js draws it
// before dispatching here. Everything below is overlay.
//
// The layout law, inherited from the reflex game and still correct: the top
// strip is readouts, the bottom of the screen is thumb space, and nothing that
// must be read lives under a thumb.

import { VW, LADDER, TIERS, AUTO, OVERDRIVE, GOV_STEPS, PRESTIGE_STEPS, CHALLENGES, AWAY, GATE } from './config.js';
import { outlinedText, roundRect, polygon, withAlpha, clamp } from '../core/draw.js';
import { panel, meter } from '../core/widgets.js';
import { Scroller } from '../core/scroll.js';
import * as B from '../core/big.js';
import * as E from './economy.js';
import { humanDuration } from '../core/awaytime.js';
import { LAYERS, layerNamesBetween } from './layers.js';

const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
const TAU = Math.PI * 2;

const scrollers = { drives: new Scroller(), board: new Scroller(), away: new Scroller() };

function txt(ctx, s, x, y, size, color, opts = {}) {
  outlinedText(ctx, s, x, y, {
    size, weight: opts.weight ?? 800, color, outlineWidth: opts.outline ?? 3,
    font: FONT, align: opts.align ?? 'center',
  });
}

/** A dim slab behind readouts so they stay legible over a bright tunnel. */
function scrim(ctx, x, y, w, h, a = 0.55) {
  roundRect(ctx, x, y, w, h, 16);
  ctx.fillStyle = `rgba(4,6,14,${a})`;
  ctx.fill();
}

// =========================================================== THE BORE

export function drawBore(ctx, g, view, dt) {
  const { ui, input, st, world } = g;
  const pal = g.renderer.pal ?? g.renderer.palette(0);
  const top = view.insetTop;
  const bottom = view.vh - view.insetBottom;

  // ---- the readout strip
  scrim(ctx, 16, top + 6, VW - 32, 150, 0.5);
  txt(ctx, B.fmt(st.depth), VW / 2, top + 62, 58, '#FFFFFF', { weight: 900, outline: 6 });
  txt(ctx, `${B.fmt(E.rate(st))} / SEC`, VW / 2, top + 92, 20, withAlpha('#FFFFFF', 0.65));

  // Warp meter — the same 0..1 that is bending the picture behind it.
  const bx = 40;
  const bw = VW - 80;
  meter(ctx, bx, top + 108, bw, 10, world.warp, { fill: pal.edge, radius: 5 });
  txt(ctx, pal.name ?? '', bx, top + 138, 16, withAlpha(pal.edge, 0.9), { align: 'left' });
  txt(ctx, `FIELD ${world.band}`, bx + bw, top + 138, 16, withAlpha('#FFFFFF', 0.5), { align: 'right' });

  // ---- currency chips
  let cy = top + 176;
  chip(ctx, 24, cy, 210, 'PHOTONS', B.fmt(st.photons.bank), '#FFD34F');
  chip(ctx, 255, cy, 210, 'PROPER TIME', B.fmt(st.tau.bank), '#8dffd0');
  chip(ctx, 486, cy, 210, 'OMEGA', String(st.omega.total - st.omega.bore - st.omega.drift - st.omega.stasis), '#ff7ae0');

  // ---- the next structural threshold, always named as a hard number
  const nxt = nextThreshold(st);
  scrim(ctx, 24, cy + 66, VW - 48, 40, 0.45);
  txt(ctx, nxt, VW / 2, cy + 92, 18, withAlpha('#FFFFFF', 0.8));

  // ---- the drive ladder
  const listY = cy + 118;
  const listH = bottom - listY - 190;
  const rowH = 84;
  const pitch = 90;
  const contentH = st.tiers * pitch;
  const off = scrollers.drives.begin(ctx, input, dt, 16, listY, VW - 32, listH, contentH);
  for (let k = 1; k <= st.tiers; k++) {
    const y = listY + (k - 1) * pitch - off;
    if (y + rowH < listY - 20 || y > listY + listH + 20) continue;
    driveRow(ctx, g, view, dt, k, y, rowH, pitch, pal);
  }
  scrollers.drives.end(ctx);

  // ---- PRIME: one button, always the correct tap
  const p = g.prime();
  const collapseWorth = E.canCollapse(st);
  const py = bottom - 168;
  if (collapseWorth) {
    const gain = E.collapseGain(st);
    if (ui.button(ctx, input, dt, 'prime', 28, py, VW - 56, 76, `COLLAPSE — +${B.fmt(gain)} PHOTONS`, {
      textSize: 24, stroke: '#FFD34F', fill: '#3a2e10', radius: 18, pitch: 84, glow: 10,
    })) g.doCollapse();
  } else if (p) {
    const nm = LADDER[p.k - 1];
    if (ui.button(ctx, input, dt, 'prime', 28, py, VW - 56, 76, `BUY ${nm}`, {
      textSize: 24, stroke: pal.edge, fill: '#141d3a', radius: 18, pitch: 84,
      sub: B.fmt(p.cost),
    })) g.buyTier(p.k, 1);
  } else {
    scrim(ctx, 28, py, VW - 56, 76, 0.4);
    txt(ctx, 'FALLING', VW / 2, py + 46, 24, withAlpha('#FFFFFF', 0.45));
  }

  // ---- max all / boards / settings
  const by = bottom - 82;
  if (ui.button(ctx, input, dt, 'maxall', 28, by, 200, 70, 'MAX ALL', {
    textSize: 22, stroke: '#6a6aa0', fill: '#141634', radius: 18, pitch: 78,
  })) g.buyMaxAll();
  if (ui.button(ctx, input, dt, 'boards', 244, by, 200, 70, 'BOARDS', {
    textSize: 22, stroke: '#6a6aa0', fill: '#141634', radius: 18, pitch: 78,
  })) { g.screen = 'boards'; g.sfxConfirm(); }
  if (ui.button(ctx, input, dt, 'settings', 460, by, 232, 70, 'SETTINGS', {
    textSize: 22, stroke: '#6a6aa0', fill: '#141634', radius: 18, pitch: 78,
  })) { g.screen = 'settings'; g.sfxConfirm(); }

  bannerLine(ctx, g, view);
}

function chip(ctx, x, y, w, label, value, color) {
  scrim(ctx, x, y, w, 54, 0.5);
  txt(ctx, label, x + w / 2, y + 20, 13, withAlpha(color, 0.75));
  txt(ctx, value, x + w / 2, y + 44, 22, color, { weight: 900 });
}

function driveRow(ctx, g, view, dt, k, y, h, pitch, pal) {
  const { ui, input, st } = g;
  const x = 24;
  const w = VW - 48;
  scrim(ctx, x, y, w, h, 0.55);

  const owned = st.owned[k] | 0;
  const cost = E.costFor(st, k, 1);
  const can = B.lte(cost, st.depth);
  const mult = E.milestone(st, k);

  txt(ctx, LADDER[k - 1], x + 16, y + 26, 20, '#FFFFFF', { align: 'left', weight: 900 });
  txt(ctx, `${owned}`, x + 16, y + 52, 17, withAlpha('#FFFFFF', 0.6), { align: 'left' });
  txt(ctx, `x${B.fmt(mult)}`, x + 96, y + 52, 17, withAlpha(pal.edge, 0.85), { align: 'left' });

  // Milestone progress: the one bar in this game that is a genuine 0..1 count
  // rather than a log-space fraction, which is exactly why it earns its place.
  const into = owned % 20;
  meter(ctx, x + 16, y + 62, 190, 6, into / 20, { fill: '#FFD34F', radius: 3 });
  txt(ctx, `${into}/20`, x + 214, y + 68, 13, withAlpha('#FFD34F', 0.8), { align: 'left' });

  if (ui.button(ctx, input, dt, `buy${k}`, x + w - 214, y + 12, 200, h - 24, B.fmt(cost), {
    textSize: 20, disabled: !can, radius: 14, pitch,
    stroke: can ? pal.edge : '#4a4a6a', fill: can ? '#182246' : '#12121e',
    sub: 'BUY',
  })) g.buyTier(k, st.auto.bulk ? Infinity : 1);
}

/** The next thing that structurally changes, named as a hard number. */
function nextThreshold(st) {
  if (!E.canCollapse(st) && st.collapses === 0) {
    return `COLLAPSE AT ${B.fmt(GATE.collapse)} DEPTH — NOW ${B.fmt(st.depth)}`;
  }
  if (!E.canDilate(st)) {
    return `DILATE NEEDS ${B.fmt(GATE.dilate)} LIFETIME PHOTONS — HAVE ${B.fmt(st.photons.life)}`;
  }
  const need = B.pow10(st.omega.total + 6);
  if (!E.canHorizon(st)) {
    return `EVENT HORIZON NEEDS ${B.fmt(need)} PROPER TIME — HAVE ${B.fmt(st.tau.life)}`;
  }
  return 'EVENT HORIZON AVAILABLE';
}

function bannerLine(ctx, g, view) {
  if (!(g.bannerT > 0)) return;
  // Over its own slab. Without one it lands on top of the drive list and both
  // become unreadable — caught by looking at a screenshot, not by a test.
  const y = view.vh * 0.42;
  ctx.save();
  ctx.globalAlpha = clamp(g.bannerT * 1.2, 0, 1);
  scrim(ctx, 20, y - 34, VW - 40, 64, 0.88);
  txt(ctx, g.banner, VW / 2, y + 10, 30, '#FFFFFF', { weight: 900, outline: 5 });
  ctx.restore();
}

// =========================================================== THE BOARDS

export function drawBoards(ctx, g, view, dt) {
  const { ui, input, st } = g;
  const pal = g.renderer.pal ?? g.renderer.palette(0);
  const top = view.insetTop;
  const bottom = view.vh - view.insetBottom;
  const names = ['PHOTON BOARD', 'TAU BOARD', 'HORIZON'];
  const colors = ['#FFD34F', '#8dffd0', '#ff7ae0'];

  scrim(ctx, 16, top + 6, VW - 32, 60, 0.6);
  if (ui.button(ctx, input, dt, 'boardtab', 24, top + 10, VW - 48, 52, names[g.board], {
    textSize: 26, stroke: colors[g.board], fill: '#141634', radius: 14, pitch: 60,
  })) { g.board = (g.board + 1) % 3; scrollers.board.reset(); g.sfxConfirm(); }

  const bankLabel = g.board === 0
    ? `${B.fmt(st.photons.bank)} PHOTONS`
    : g.board === 1
      ? `${B.fmt(st.tau.bank)} PROPER TIME`
      : `${st.omega.total - st.omega.bore - st.omega.drift - st.omega.stasis} OMEGA FREE`;
  txt(ctx, bankLabel, VW / 2, top + 92, 22, colors[g.board], { weight: 900 });

  const listY = top + 110;
  const listH = bottom - listY - 92;
  const rows = g.board === 0 ? photonRows(g) : g.board === 1 ? tauRows(g) : omegaRows(g);
  const pitch = 84;
  const off = scrollers.board.begin(ctx, input, dt, 16, listY, VW - 32, listH, rows.length * pitch + 8);
  rows.forEach((r, i) => {
    const y = listY + i * pitch - off;
    if (y + 76 < listY - 20 || y > listY + listH + 20) return;
    boardRow(ctx, g, view, dt, r, y, pitch, pal);
  });
  scrollers.board.end(ctx);

  if (ui.button(ctx, input, dt, 'bback', 28, bottom - 82, VW - 56, 70, 'BACK', {
    textSize: 28, stroke: pal.edge, fill: '#141d3a', radius: 18, pitch: 78,
  })) { g.screen = 'bore'; g.sfxBack(); }

  bannerLine(ctx, g, view);
}

function boardRow(ctx, g, view, dt, r, y, pitch, pal) {
  const { ui, input } = g;
  const x = 24;
  const w = VW - 48;
  scrim(ctx, x, y, w, 76, 0.55);
  txt(ctx, r.name, x + 16, y + 28, 20, r.owned ? withAlpha('#FFFFFF', 0.5) : '#FFFFFF', { align: 'left', weight: 900 });
  txt(ctx, r.sub, x + 16, y + 54, 16, withAlpha('#FFFFFF', 0.55), { align: 'left' });
  if (r.owned) {
    txt(ctx, r.ownedLabel ?? 'OWNED', x + w - 22, y + 44, 20, withAlpha('#8dffd0', 0.9), { align: 'right' });
    return;
  }
  if (ui.button(ctx, input, dt, r.key, x + w - 214, y + 10, 200, 56, r.cost, {
    textSize: 20, disabled: !r.can, radius: 14, pitch,
    stroke: r.can ? pal.edge : '#4a4a6a', fill: r.can ? '#182246' : '#12121e',
  })) r.act();
}

function photonRows(g) {
  const st = g.st;
  const rows = [];
  const afford = (c) => B.gte(st.photons.bank, B.big(c));
  for (let k = 1; k <= st.tiers; k++) {
    const c = Math.pow(AUTO.driveBase, k - 1);
    rows.push({
      key: `ad${k}`, name: `AUTO-DRIVE ${LADDER[k - 1]}`, sub: 'BUYS THIS TIER FOR YOU',
      owned: st.auto.drive[k], cost: B.fmt(B.big(c)), can: afford(c),
      act: () => g.spendPhotons(c, () => { st.auto.drive[k] = true; }),
    });
  }
  rows.push({
    key: 'bulk', name: 'BULK', sub: 'EVERY BUY BECOMES BUY-MAX',
    owned: st.auto.bulk, cost: B.fmt(B.big(AUTO.bulk)), can: afford(AUTO.bulk),
    act: () => g.spendPhotons(AUTO.bulk, () => { st.auto.bulk = true; }),
  });
  if (st.auto.governor) {
    rows.push({
      key: 'gov', name: 'GOVERNOR', sub: `RESERVE ${Math.round(GOV_STEPS[st.gov] * 100)}% FOR THE BIG TIERS`,
      owned: false, cost: 'CHANGE', can: true,
      act: () => { st.gov = (st.gov + 1) % GOV_STEPS.length; g.sfxConfirm(); g.commit(true); },
    });
  } else {
    rows.push({
      key: 'gov', name: 'GOVERNOR', sub: 'STOP CHEAP TIERS STARVING EXPENSIVE ONES',
      owned: false, cost: B.fmt(B.big(AUTO.governor)), can: afford(AUTO.governor),
      act: () => g.spendPhotons(AUTO.governor, () => { st.auto.governor = true; st.gov = 1; }),
    });
  }
  if (st.auto.collapse) {
    rows.push({
      key: 'acol', name: 'AUTO-COLLAPSE', sub: `FIRES AT x${PRESTIGE_STEPS[st.thr.collapse]} YOUR BANK`,
      owned: false, cost: 'CHANGE', can: true,
      act: () => { st.thr.collapse = (st.thr.collapse + 1) % PRESTIGE_STEPS.length; g.sfxConfirm(); g.commit(true); },
    });
  } else {
    rows.push({
      key: 'acol', name: 'AUTO-COLLAPSE', sub: 'RUNS THE CYCLE WHILE YOU ARE AWAY',
      owned: false, cost: B.fmt(B.big(AUTO.collapse)), can: afford(AUTO.collapse),
      act: () => g.spendPhotons(AUTO.collapse, () => { st.auto.collapse = true; }),
    });
  }
  const od = st.auto.overdrive;
  const odCost = OVERDRIVE.base * Math.pow(OVERDRIVE.ratio, od);
  rows.push({
    key: 'od', name: `CORE OVERDRIVE ${od}/${OVERDRIVE.levels}`,
    sub: `x${OVERDRIVE.mult} OUTPUT PER LEVEL`,
    owned: od >= OVERDRIVE.levels, ownedLabel: 'MAX',
    cost: B.fmt(B.big(odCost)), can: afford(odCost),
    act: () => g.spendPhotons(odCost, () => { st.auto.overdrive++; }),
  });
  return rows;
}

function tauRows(g) {
  const st = g.st;
  const rows = [];
  if (st.auto.dilate) {
    rows.push({
      key: 'adil', name: 'AUTO-DILATE', sub: `FIRES AT x${PRESTIGE_STEPS[st.thr.dilate]} YOUR BANK`,
      owned: false, cost: 'CHANGE', can: true,
      act: () => { st.thr.dilate = (st.thr.dilate + 1) % PRESTIGE_STEPS.length; g.sfxConfirm(); g.commit(true); },
    });
  } else {
    rows.push({
      key: 'adil', name: 'AUTO-DILATE', sub: 'RUNS THE DILATE CYCLE FOR YOU',
      owned: false, cost: B.fmt(B.big(AUTO.dilate)), can: B.gte(st.tau.bank, B.big(AUTO.dilate)),
      act: () => g.spendTau(AUTO.dilate, () => { st.auto.dilate = true; }),
    });
  }
  for (const c of CHALLENGES) {
    const done = !!st.done[c.id];
    const active = st.challenge?.id === c.id;
    rows.push({
      key: `ch${c.id}`, name: c.name,
      sub: done ? c.reward : active ? `TARGET 1e${Math.round(st.challenge.targetLog)} DEPTH` : `${c.handicap} -> ${c.reward}`,
      owned: done, ownedLabel: 'DONE',
      cost: active ? 'LEAVE' : 'ENTER', can: st.omega.total > 0,
      act: () => {
        if (active) E.exitChallenge(st);
        else E.enterChallenge(st, c.id);
        g.sfxConfirm();
        g.commit(true);
      },
    });
  }
  return rows;
}

function omegaRows(g) {
  const st = g.st;
  const free = st.omega.total - st.omega.bore - st.omega.drift - st.omega.stasis;
  const mk = (key, name, sub, sink, cap) => ({
    key, name, sub, owned: false,
    cost: `${st.omega[sink]}${cap ? `/${cap}` : ''}  +`,
    can: free > 0 && (!cap || st.omega[sink] < cap),
    act: () => { if (E.allocate(st, sink, 1)) { g.sfxConfirm(); g.commit(true); } },
    minus: () => { if (E.allocate(st, sink, -1)) { g.sfxBack(); g.commit(true); } },
  });
  return [
    mk('om_bore', 'BORE', `+1 DRIVE TIER — NOW ${st.tiers}`, 'bore', TIERS.max - TIERS.base),
    mk('om_drift', 'DRIFT', `x3 OUTPUT EACH — NOW x${B.fmt(B.pow10(Math.log10(3) * st.omega.drift))}`, 'drift', 0),
    mk('om_stasis', 'STASIS', `+24H AWAY CAP — NOW ${Math.round(E.awayCapSeconds(st) / 3600)}H`, 'stasis', AWAY.stasisMax),
  ];
}

// =========================================================== AWAY PANEL

export function drawAway(ctx, g, view, dt) {
  const { ui, input, st } = g;
  const pal = g.renderer.pal ?? g.renderer.palette(0);
  const led = g.ledger;
  const top = view.insetTop;
  const bottom = view.vh - view.insetBottom;
  if (!led) { g.screen = 'bore'; return; }

  ctx.save();
  ctx.fillStyle = 'rgba(2,4,10,0.72)';
  ctx.fillRect(0, 0, VW, view.vh);
  ctx.restore();

  // Lead with the fantasy, not the ledger.
  txt(ctx, 'YOU FELL FOR', VW / 2, top + 90, 22, withAlpha('#FFFFFF', 0.6));
  txt(ctx, humanDuration(led.seconds), VW / 2, top + 146, 44, '#FFFFFF', { weight: 900, outline: 6 });
  txt(ctx, `${B.fmt(B.big(led.properSeconds))} SECONDS OF PROPER TIME`, VW / 2, top + 192, 22, '#8dffd0');

  const listY = top + 226;
  const listH = bottom - listY - 110;
  const lines = [];
  const gained = B.log10(B.add(B.ONE, led.depthAfter ?? st.depth)) - B.log10(B.add(B.ONE, led.depthBefore));
  if (Number.isFinite(gained) && gained > 0) lines.push([`DEPTH GAINED`, `${gained.toFixed(1)} ORDERS OF MAGNITUDE`]);
  if (led.collapsesRun > 0) lines.push(['COLLAPSES RUN', String(led.collapsesRun)]);
  if (led.dilatesRun > 0) lines.push(['DILATES RUN', String(led.dilatesRun)]);
  lines.push(['CLOCK', `x${E.dilation(st).toFixed(2)} PROPER TIME`]);
  // What the tunnel itself gained while you were gone. This is the reason to
  // look at the screen rather than the ledger.
  if (led.bandAfter > led.bandBefore) {
    lines.push(['DEPTH FIELD', `${led.bandBefore} -> ${led.bandAfter}`]);
    for (const n of layerNamesBetween(led.bandBefore, led.bandAfter)) {
      lines.push(['NEW IN THE BORE', n]);
    }
  }
  if (led.capped) {
    lines.push(['CAPPED AT', `${Math.round(E.awayCapSeconds(st) / 3600)} HOURS`]);
  }
  if (led.throttled) lines.push(['THROTTLED', 'CLOCK MOVED FASTER THAN TIME']);
  if (g.save.clock?.suspect) lines.push(['NOTE', 'CLOCK DRIFT OBSERVED']);

  const off = scrollers.away.begin(ctx, input, dt, 16, listY, VW - 32, listH, lines.length * 56 + 90);
  lines.forEach(([k, v], i) => {
    const y = listY + i * 56 - off;
    scrim(ctx, 24, y, VW - 48, 48, 0.5);
    txt(ctx, k, 44, y + 31, 17, withAlpha('#FFFFFF', 0.55), { align: 'left' });
    txt(ctx, v, VW - 44, y + 31, 19, '#FFFFFF', { align: 'right' });
  });
  const noteY = listY + lines.length * 56 - off + 12;
  txt(ctx, 'YOUR AWAY TIME RAN AT FULL RATE.', VW / 2, noteY + 18, 15, withAlpha('#FFFFFF', 0.45));
  txt(ctx, 'AUTOBUYERS AND COLLAPSES RAN WHILE YOU WERE GONE.', VW / 2, noteY + 40, 15, withAlpha('#FFFFFF', 0.45));
  scrollers.away.end(ctx);

  // If the absence hit the cap and STASIS is unallocated, offer it right here —
  // the exact moment the friction is felt.
  const free = st.omega.total - st.omega.bore - st.omega.drift - st.omega.stasis;
  if (led.capped && free > 0 && st.omega.stasis < AWAY.stasisMax) {
    if (ui.button(ctx, input, dt, 'stasisnow', 28, bottom - 166, VW - 56, 70, '+24H AWAY CAP (1 OMEGA)', {
      textSize: 22, stroke: '#ff7ae0', fill: '#2a1030', radius: 18, pitch: 78,
    })) { E.allocate(st, 'stasis', 1); g.sfxConfirm(); g.commit(true); }
  }

  if (ui.button(ctx, input, dt, 'descend', 28, bottom - 84, VW - 56, 72, 'DESCEND', {
    textSize: 30, stroke: pal.edge, fill: '#141d3a', radius: 18, pitch: 80, glow: 8,
  })) { g.ledger = null; g.screen = 'bore'; g.sfxConfirm(); }
}

// =========================================================== SETTINGS

export function drawSettings(ctx, g, view, dt) {
  const { ui, input, save, st } = g;
  const pal = g.renderer.pal ?? g.renderer.palette(0);
  const top = view.insetTop;
  const bottom = view.vh - view.insetBottom;

  ctx.save();
  ctx.fillStyle = 'rgba(2,4,10,0.72)';
  ctx.fillRect(0, 0, VW, view.vh);
  ctx.restore();

  txt(ctx, 'SETTINGS', VW / 2, top + 54, 46, '#FFFFFF', { weight: 900, outline: 5 });

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

  txt(ctx, `${st.collapses} COLLAPSES · ${st.dilates} DILATES · ${st.horizons} HORIZONS`,
    VW / 2, y, 18, withAlpha('#FFFFFF', 0.4), { weight: 700, outline: 2 });

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
    g.screen = 'bore';
    g.sfxBack();
  }
}
