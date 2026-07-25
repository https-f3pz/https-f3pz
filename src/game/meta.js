// Everything that outlives a dive: records, shards, hook upgrades, rotating
// missions, the daily seed, and the one sentence that makes you dive again.

import { UPGRADES, MISSION_POOL, RANKS, rankFor } from './config.js';
import { save as writeSave, flushNow } from '../core/storage.js';
import { hashSeed, makeRng } from '../core/rng.js';

export function todayKey(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

// The offline substitute for a leaderboard: everyone diving on the same date
// gets the same shaft, verifiably, with no network involved.
export function dailySeed(key = todayKey()) {
  return hashSeed(`HOOKFALL${key}`);
}

export function rollMissions(save) {
  const rng = makeRng(hashSeed(`m${save.missionSets ?? 0}:${save.runs ?? 0}`));
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

export function upgradeTier(save, id) {
  return save.upgrades?.[id] ?? 0;
}

export function upgradeCost(save, id) {
  const u = UPGRADES.find((x) => x.id === id);
  const tier = upgradeTier(save, id);
  return tier >= u.costs.length ? null : u.costs[tier];
}

export function buyUpgrade(save, id) {
  const cost = upgradeCost(save, id);
  if (cost == null || (save.shards ?? 0) < cost) return false;
  save.shards -= cost;
  save.upgrades[id] = upgradeTier(save, id) + 1;
  writeSave(save);
  flushNow();
  return true;
}

function progressMissions(save, run, out) {
  const missions = ensureMissions(save);
  for (const m of missions) {
    if (m.done) continue;
    let v = 0;
    switch (m.id) {
      case 'graze40': v = run.grazeCount; break;
      case 'depth6k': v = run.depth; break;
      case 'gems12': v = run.gems; break;
      case 'chain20': v = run.bestCombo; break;
      case 'whip15': v = run.whipcracks; break;
      case 'speed4k': v = run.topSpeed; break;
      case 'noreel': v = run.reeled ? 0 : run.depth; break;
      case 'gate3': v = run.depth; break;
      default: v = 0;
    }
    m.prog = Math.max(m.prog, v);
    if (m.prog >= m.goal) {
      m.done = true;
      save.shards = (save.shards ?? 0) + 300;
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
  // One seed, one shot. Without this the daily is unlimited retries and the
  // streak it feeds means nothing as a comparison.
  if (d.date === key && d.locked) return;
  if (d.date !== key) {
    const yesterday = todayKey(new Date(Date.now() - 86400000));
    d.streak = d.date === yesterday ? (d.streak || 0) + 1 : 1;
    d.date = key;
  }
  d.depth = run.depth;
  d.score = run.score;
  d.locked = true;
  d.history = [...(d.history || []).filter((h) => h.date !== key), { date: key, depth: d.depth }].slice(-30);
}

/** Folds a finished dive into the save and returns what to celebrate. */
export function recordRun(save, run, ctx = {}) {
  const out = { newBest: false, missionsDone: [], missionSetCleared: false, shardsEarned: 0 };

  out.newBest = run.depth > (save.best || 0);
  const earned = Math.floor(run.shards);
  out.shardsEarned = earned;

  save.runs = (save.runs || 0) + 1;
  save.best = Math.max(save.best || 0, run.depth);
  save.bestScore = Math.max(save.bestScore || 0, run.score);
  save.bestCombo = Math.max(save.bestCombo || 0, run.bestCombo);
  save.totalDepth = (save.totalDepth || 0) + run.depth;
  save.gems = (save.gems || 0) + run.gems;
  save.shards = (save.shards || 0) + earned;
  save.depths20 = [...(save.depths20 || []), Math.round(run.depth)].slice(-20);

  progressMissions(save, run, out);
  updateDaily(save, run, ctx.isDaily);

  writeSave(save);
  flushNow(); // exactly one synchronous write per dive
  return out;
}

/**
 * One sentence about the dive you just had. Legible failure is worth more
 * than any unlock, and in a physics game the useful note is almost always
 * about *when you let go*.
 */
export function coachingLine(run) {
  if (run.deathCause === 'collapse') {
    return run.hookTime > run.time * 0.55
      ? 'THE COLLAPSE TOOK YOU — YOU HUNG ON TOO LONG.'
      : 'THE COLLAPSE TOOK YOU. SWING SHORTER, RELEASE EARLIER.';
  }
  if (run.deathCause === 'hazard' && run.topSpeed > 3200) {
    return `${Math.round(run.topSpeed)} px/s INTO A HAZARD. FAST IS ONLY FREE IF YOU CAN STEER.`;
  }
  if (run.hooks === 0) return 'YOU NEVER FIRED THE HOOK. PRESS ANYWHERE — IT AIMS FOR YOU.';
  if (run.whipcracks === 0 && run.hooks >= 4) return 'NO WHIPCRACKS. RELEASE AT THE BOTTOM OF THE SWING.';
  if (run.bestCombo >= 20) return `${run.bestCombo} CHAIN. THAT IS THE GAME.`;
  if (run.bestCombo <= 3 && run.depth > 800) return 'ALMOST NO GRAZES. FLY CLOSER — NEAR MISSES ARE THE SCORE.';
  if (!run.reeled && run.depth > 1500) return 'YOU NEVER REELED. SLIDE YOUR THUMB UP MID-SWING TO PUMP SPEED.';
  if (run.whipcracks >= 6) return `${run.whipcracks} WHIPCRACKS. NOW GO DEEPER.`;
  return `${Math.round(run.depth)} m. THE SHAFT GOES A LOT FURTHER.`;
}

export function rank(m) {
  return rankFor(m);
}

export { RANKS };
