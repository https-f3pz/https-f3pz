// Everything that outlives a run: records, core unlocks, pressure tiers,
// marks, rotating missions, the daily seed, and the one coaching sentence
// that actually makes people press AGAIN.

import { CORES, MARKS, MISSION_POOL, PRESSURE, RANKS, rankFor } from './config.js';
import { save as writeSave, flushNow } from '../core/storage.js';
import { hashSeed, makeRng } from '../core/rng.js';

export function todayKey(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

// The offline substitute for a leaderboard: everyone with the same date gets
// the same run, verifiably, with no network involved.
export function dailySeed(key = todayKey()) {
  return hashSeed(`FLASHOVER${key}`);
}

export function rollMissions(save) {
  const rng = makeRng(hashSeed(`missions${save.missionSets ?? 0}${save.runs ?? 0}`));
  const pool = [...MISSION_POOL];
  rng.shuffle(pool);
  return pool.slice(0, 3).map((m) => ({ id: m.id, text: m.text, goal: m.goal, prog: 0, done: false }));
}

export function ensureMissions(save) {
  if (!save.missions || !save.missions.length) {
    save.missions = rollMissions(save);
    writeSave({ missions: save.missions });
  }
  return save.missions;
}

export function coreById(id) {
  return CORES.find((c) => c.id === id) || CORES[0];
}

export function coreUnlocked(save, core) {
  if (!core.unlock) return true;
  return (save.unlockedCores || []).includes(core.id);
}

// Checks core unlock conditions against a finished run.
function checkCoreUnlocks(save, run, out) {
  for (const core of CORES) {
    if (!core.unlock || save.unlockedCores.includes(core.id)) continue;
    const hit =
      (core.unlock.kind === 'score' && run.score >= core.unlock.value) ||
      (core.unlock.kind === 'time' && run.time >= core.unlock.value);
    if (hit) {
      save.unlockedCores.push(core.id);
      out.unlocked.push(core);
    }
  }
}

function award(save, id, out) {
  if (save.marks[id]) return;
  save.marks[id] = true;
  out.marks.push(MARKS.find((m) => m.id === id));
}

function checkMarks(save, run, ctx, out) {
  const t = run.tel;
  if (!run.everVented && run.score >= 60000) award(save, 'cold', out);
  if (t.above95 >= 14) award(save, 'redline', out);
  if (run.flashCount >= 5) award(save, 'furnace', out);
  if (run.sparkUsed && ctx.newBest) award(save, 'spark', out);
  if (run.time >= 120) award(save, 'ironclad', out);
  if (run.bestVent >= 6000) award(save, 'overdraw', out);
  if (ctx.declinedAll && run.score >= 40000) award(save, 'purist', out);
  if ((save.daily?.streak ?? 0) >= 7) award(save, 'devotee', out);
}

function progressMissions(save, run, out) {
  const missions = ensureMissions(save);
  const t = run.tel;
  for (const m of missions) {
    if (m.done) continue;
    let v = 0;
    switch (m.id) {
      case 'hold95': v = t.above95; break;
      case 'novent60k': v = run.everVented ? 0 : run.score; break;
      case 'flash3': v = run.flashCount; break;
      case 'survive100': v = run.time; break;
      case 'husk2': v = run.huskKills; break;
      case 'vent5k': v = run.bestVent; break;
      case 'mult10': v = t.mult10Best; break;
      case 'graze90': v = t.above70; break;
      default: v = 0;
    }
    m.prog = Math.max(m.prog, v);
    if (m.prog >= m.goal) {
      m.done = true;
      out.missionsDone.push(m);
    }
  }
  if (missions.every((m) => m.done)) {
    save.missionSets = (save.missionSets ?? 0) + 1;
    save.missions = rollMissions(save);
    out.missionSetCleared = true;
  }
}

function updateDaily(save, run, isDaily) {
  if (!isDaily) return;
  const key = todayKey();
  const d = save.daily;
  // One seed, one shot: once today's attempt is banked, further runs on the
  // same seed are practice. Without this the daily was unlimited retries and
  // the streak it feeds was meaningless as a comparison.
  if (d.date === key && d.locked) return;
  if (d.date !== key) {
    // A streak only survives if yesterday was played.
    const yesterday = todayKey(new Date(Date.now() - 86400000));
    d.streak = d.date === yesterday ? (d.streak || 0) + 1 : 1;
    d.date = key;
    d.score = 0;
  }
  d.score = run.score;
  d.locked = true;
  d.history = [...(d.history || []).filter((h) => h.date !== key), { date: key, score: d.score }].slice(-30);
}

/**
 * Folds a finished run into the save. Returns everything the results screen
 * needs to celebrate, so the screen itself does no bookkeeping.
 */
export function recordRun(save, run, ctx = {}) {
  const out = { unlocked: [], marks: [], missionsDone: [], newBest: false, missionSetCleared: false };

  out.newBest = run.score > save.best;
  ctx.newBest = out.newBest;

  save.runs = (save.runs || 0) + 1;
  save.best = Math.max(save.best || 0, run.score);
  save.bestTime = Math.max(save.bestTime || 0, run.time);
  save.totalFlashovers = (save.totalFlashovers || 0) + run.flashCount;
  save.timeAboveHeat50 = (save.timeAboveHeat50 || 0) + run.tel.above50;
  save.bestMultHeld10s = Math.max(save.bestMultHeld10s || 0, run.tel.mult10Best >= 10 ? run.tel.mult10Best : 0);
  save.scores20 = [...(save.scores20 || []), Math.round(run.score)].slice(-20);

  const coreId = ctx.coreId || save.core || 'needle';
  const cell = save.cores[coreId] || (save.cores[coreId] = { best: 0, bestTime: 0, pressure: 0, bestPressure: 0 });
  cell.best = Math.max(cell.best || 0, run.score);
  cell.bestTime = Math.max(cell.bestTime || 0, run.time);

  // Pressure tiers: tier 1 opens after your first ignition with a core, each
  // later tier after clearing the previous with a 60s+ run.
  const tier = ctx.pressure ?? 0;
  if (tier === 0 && run.flashCount >= 1) cell.bestPressure = Math.max(cell.bestPressure || 0, 1);
  else if (tier > 0 && run.time >= 60) cell.bestPressure = Math.max(cell.bestPressure || 0, Math.min(PRESSURE.length, tier + 1));

  checkCoreUnlocks(save, run, out);
  checkMarks(save, run, ctx, out);
  progressMissions(save, run, out);
  updateDaily(save, run, ctx.isDaily);

  writeSave(save);
  flushNow(); // exactly one synchronous write per run, at the only safe moment
  return out;
}

/**
 * One sentence, chosen by priority, that tells the player what to do
 * differently. Legible failure is worth more than any unlock.
 */
export function coachingLine(run, ventMode = 'lift') {
  const t = run.tel;
  const avgVent = t.ventHeatN ? t.ventHeatSum / t.ventHeatN : 0;

  if (t.above90 >= 10) return `YOU HELD 90+ FOR ${Math.round(t.above90)}s. THAT IS THE GAME.`;
  if (run.time > 12 && t.belowHeat30 > run.time * 0.5)
    return `YOU SPENT ${Math.round(t.belowHeat30)}s BELOW HEAT 30 — GET CLOSER.`;
  if (t.ventHeatN >= 2 && avgVent < 60) return `AVERAGE VENT AT ${Math.round(avgVent)} HEAT — PUSH TO 80.`;
  if (run.flashCount === 0 && t.peakHeat >= 70)
    return `PEAKED AT ${Math.round(t.peakHeat)} HEAT. ONE MORE GRAZE AND YOU IGNITE.`;
  if (run.flashCount === 0) return 'NO FLASHOVER. HUG THE BULLETS — THEY ARE THE FUEL.';
  if (run.flashCount >= 3) return `${run.flashCount} FLASHOVERS. NOW TRY ${run.flashCount + 1}.`;
  if (!run.everVented && run.time > 30) {
    // Must match the player's actual control scheme, or the game's own
    // coaching teaches them their controls are broken.
    return ventMode === 'secondTap'
      ? 'YOU NEVER VENTED. TAP A SECOND FINGER AT 80+ AND SEE.'
      : 'YOU NEVER VENTED. LIFT YOUR THUMB AT 80+ AND SEE.';
  }
  if (run.sparkUsed) return 'SECOND SPARK SAVED YOU. IT ONLY WORKS ABOVE 85.';
  return `${run.flashCount} FLASHOVER${run.flashCount === 1 ? '' : 'S'}. NOW TRY ${run.flashCount + 1}.`;
}

export function rank(score) {
  return rankFor(score);
}

export function nextRank(score) {
  for (const r of RANKS) if (r.at > score) return r;
  return null;
}

export function pressureUnlocked(save, coreId) {
  return save.cores?.[coreId]?.bestPressure ?? 0;
}
