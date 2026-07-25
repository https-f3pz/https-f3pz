// Everything that outlives a run: records, shards, upgrades, missions, the
// daily seed, and the one sentence that makes you press GO again.

import { UPGRADES, MISSION_POOL, RANKS, rankFor } from './config.js';
import { save as writeSave, flushNow } from '../core/storage.js';
import { hashSeed, makeRng } from '../core/rng.js';

export function todayKey(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

// Everyone diving on the same date gets the same tube, with no network.
export function dailySeed(key = todayKey()) {
  return hashSeed(`REDSHIFT${key}`);
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
  const t = upgradeTier(save, id);
  return t >= u.costs.length ? null : u.costs[t];
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
  for (const m of ensureMissions(save)) {
    if (m.done) continue;
    let v = 0;
    switch (m.id) {
      case 'dist5k': v = run.dist; break;
      case 'chain20': v = run.bestCombo; break;
      case 'top4k': v = run.topSpeed; break;
      case 'clean40': v = run.bestCleanGates; break;
      case 'zone3': v = run.dist; break;
      case 'graze60': v = run.grazes; break;
      default: v = 0;
    }
    m.prog = Math.max(m.prog, v);
    if (m.prog >= m.goal) {
      m.done = true;
      save.shards = (save.shards ?? 0) + 250;
      out.missionsDone.push(m);
    }
  }
  if (save.missions.every((m) => m.done)) {
    save.missionSets = (save.missionSets ?? 0) + 1;
    save.missions = rollMissions(save);
    out.missionSetCleared = true;
  }
}

function updateDaily(save, run, isDaily) {
  if (!isDaily) return;
  const key = todayKey();
  const d = save.daily;
  // One seed, one shot: otherwise the streak it feeds means nothing.
  if (d.date === key && d.locked) return;
  if (d.date !== key) {
    const yesterday = todayKey(new Date(Date.now() - 86400000));
    d.streak = d.date === yesterday ? (d.streak || 0) + 1 : 1;
    d.date = key;
  }
  d.dist = run.dist;
  d.score = run.score;
  d.locked = true;
  d.history = [...(d.history || []).filter((h) => h.date !== key), { date: key, dist: d.dist }].slice(-30);
}

export function recordRun(save, run, ctx = {}) {
  const out = { newBest: false, missionsDone: [], missionSetCleared: false, shardsEarned: 0 };
  out.newBest = run.dist > (save.best || 0);
  const earned = Math.floor(run.shards);
  out.shardsEarned = earned;

  save.runs = (save.runs || 0) + 1;
  save.best = Math.max(save.best || 0, run.dist);
  save.bestScore = Math.max(save.bestScore || 0, run.score);
  save.bestCombo = Math.max(save.bestCombo || 0, run.bestCombo);
  save.bestSpeed = Math.max(save.bestSpeed || 0, run.topSpeed);
  save.totalDist = (save.totalDist || 0) + run.dist;
  save.shards = (save.shards || 0) + earned;
  save.dists20 = [...(save.dists20 || []), Math.round(run.dist)].slice(-20);

  progressMissions(save, run, out);
  updateDaily(save, run, ctx.isDaily);

  writeSave(save);
  flushNow(); // exactly one synchronous write per run
  return out;
}

/** One sentence about the run. In this game it is almost always about speed. */
export function coachingLine(run) {
  if (run.grazes === 0 && run.gates > 6) return 'YOU PLAYED IT SAFE. THE HULL TIRES ANYWAY.';
  if (run.clips >= 6) return `${run.clips} CLIPS. EACH ONE CRACKED THE HULL A LITTLE FURTHER.`;
  if (run.topSpeed < 1600) return 'YOU NEVER GOT FAST ENOUGH TO SEE THE WARP. GRAZE MORE.';
  if (run.bestCombo >= 20) return `${run.bestCombo} CHAIN. THAT IS WHERE THE VIEW STARTS LYING.`;
  if (run.bestCombo <= 3) return 'CHAIN YOUR GRAZES — CONSECUTIVE ONES ARE WORTH FAR MORE.';
  if (run.topSpeed > 4200) return `${Math.round(run.topSpeed)} SPEED. NOW HOLD IT LONGER.`;
  return `${Math.round(run.dist).toLocaleString()} UNITS. THE TUBE DOES NOT END.`;
}

export function rank(d) {
  return rankFor(d);
}
export { RANKS };
