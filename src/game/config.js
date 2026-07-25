// Every tunable number in FLASHOVER lives here.
//
// The game is played in a fixed 360-wide logical space so that a number tuned
// once is correct on every phone; game.js scales that space to the device.

export const VW = 360; // logical width — never changes
export const VH_MIN = 560;
export const VH_MAX = 800;

// ------------------------------------------------------------------ palette

export const C = {
  ink: '#06070C',
  hull: '#7DF9FF',
  dot: '#FFFFFF',
  trail: '#2AC9E0',
  bullet: '#B8FFF6',
  pellet: '#FF2D7A',
  shard: '#FF5A3C',
  orb: '#FFB020',
  husk: '#FF2E63',
  telegraph: '#FF3B3B',
  text: '#E8F1FF',
  dim: '#7F93AD',
  gold: '#FFD34F',
};

// Heat gauge ramp stops: [heat, colour].
export const HEAT_RAMP = [
  [0, '#2AC9E0'],
  [45, '#FFB020'],
  [80, '#FF2D7A'],
  [100, '#FFFFFF'],
];

export const ERAS = [
  { t: 0, name: 'COLD START', grid: '#16324A', cadence: 1.0 },
  { t: 45, name: 'THE DRAW', grid: '#1E4A6B', cadence: 1.0 },
  { t: 90, name: 'REDLINE', grid: '#5A2A50', cadence: 1.2 },
  { t: 135, name: 'WHITEOUT', grid: '#6B2035', cadence: 1.45 },
];

// --------------------------------------------------------------------- heat

export const HEAT = {
  max: 100,
  grazeRadius: 26,
  gainPerUnit: 26, // heat/sec at w=1 for one entity
  sigmaCap: 4.0, // at most 4 entities' worth of contribution
  decay: 9, // heat/sec once the grace expires
  decayGrace: 0.5,
  // Anti-camping: contribution falls off the longer one entity is hugged.
  campFull: 1.2,
  campFade: 0.8,
  campFloor: 0.35,
  campReset: 1.5,
  ventGate: 35,
  ventArmDelay: 0.4,
  ventCooldown: 1.0,
  ventRetain: 0.55,
  ventRadius: 150,
  ventGrow: 0.22,
  ventIFrames: 0.7,
  ventIFramesMax: 1.2,
  flashAt: 100,
  flashEntry: 0.4,
  flashBody: 4.0,
  flashEndHeat: 35,
  flashLockout: 3.0,
  flashScoreMult: 3,
  sparkGate: 85, // Second Spark only saves you in the danger band
};

export const SHIP = {
  hitbox: 3,
  gain: 1.55, // drag amplification
  maxStep: 22, // px of ship movement per substep
  rebaseSlack: 40,
  fireFast: 0.07,
  fireSlow: 0.125,
  bulletSpeed: 620,
  bulletDamage: 1,
  bulletDamageAtMax: 3,
};

// ------------------------------------------------------------------ enemies

export const ENEMIES = {
  drifter: {
    id: 'drifter', hp: 3, cost: 1.0, score: 40, r: 11, sides: 4, color: C.pellet,
    speed: 55, fireEvery: 1.6, first: 0,
  },
  spinner: {
    id: 'spinner', hp: 6, cost: 2.0, score: 90, r: 14, sides: 6, color: C.orb,
    speed: 26, fireEvery: 1.1, first: 12,
  },
  lancer: {
    id: 'lancer', hp: 4, cost: 1.5, score: 70, r: 12, sides: 3, color: C.shard,
    speed: 40, dashSpeed: 420, telegraph: 0.5, fireEvery: 2.2, first: 30,
  },
  bloom: {
    id: 'bloom', hp: 8, cost: 2.5, score: 120, r: 13, sides: 0, color: C.orb,
    speed: 34, inflate: 0.9, orbs: 14, orbSpeed: 70, first: 50,
  },
};

export const HUSK = {
  id: 'husk', hp: 220, hpStep: 60, score: 2000, r: 34, sides: 8, color: C.husk,
  cycle: 4.0, firstAt: 75, every: 60,
};

// Threat-points/second the director may spend, keyed by run time.
export const BUDGET = [
  [0, 0.9], [12, 1.5], [25, 1.8], [30, 2.1], [45, 2.4],
  [50, 2.8], [70, 2.8], [75, 3.2], [95, 3.6], [120, 4.0], [135, 4.2],
];

export const CAPS = { projectiles: 180, enemies: 22, particles: 700 };

// ---------------------------------------------------------------- mutators

// `apply` mutates the run's derived stat block. Keeping them as plain data
// means a build is just a list of ids, which makes runs shareable and saves
// trivial to version.
export const MUTATORS = [
  {
    id: 'positive', name: 'POSITIVE FEEDBACK', blurb: 'HEAT GAIN +35%', num: 'IGNITE AT 120',
    apply: (s) => { s.gainMult *= 1.35; s.flashAt = 120; },
  },
  {
    id: 'thermal', name: 'THERMAL MASS', blurb: 'DECAY 9 → 4', num: 'GRACE 0.9s',
    apply: (s) => { s.decay = 4; s.decayGrace = 0.9; },
  },
  {
    // Measured at +5 this was a 9.7x score swing — with auto-fire it turned
    // the gun into an infinite heat source and every other card became noise.
    id: 'kindling', name: 'KINDLING', blurb: 'KILLS MAKE HEAT', num: '+2 PER KILL',
    apply: (s) => { s.heatPerKill += 2; },
  },
  {
    id: 'backdraft', name: 'BACKDRAFT', blurb: 'BIGGER, CHEAPER VENT', num: 'KEEP 75%',
    apply: (s) => { s.ventRadius = 215; s.ventRetain = 0.75; },
  },
  {
    id: 'bloodrush', name: 'BLOODRUSH', blurb: 'TIERS EVERY 7', num: 'UP TO 15x',
    apply: (s) => { s.multStep = 7; s.decay += 3; },
  },
  {
    id: 'magnetism', name: 'MAGNETISM', blurb: 'GRAZE RING 26 → 35', num: 'CAP 4.6',
    apply: (s) => { s.grazeRadius = 35; s.sigmaCap = 4.6; },
  },
  {
    id: 'splitfire', name: 'SPLITFIRE', blurb: '+1 SHOT PER TIER', num: 'DAMAGE -20%',
    apply: (s) => { s.extraShots += 1; s.damageMult *= 0.8; },
  },
  {
    id: 'hairtrigger', name: 'HAIRTRIGGER', blurb: 'FIRE RATE +39%', num: 'DAMAGE -15%',
    apply: (s) => { s.fireMult *= 0.72; s.damageMult *= 0.85; },
  },
  {
    id: 'flechette', name: 'FLECHETTE', blurb: 'SHOTS PIERCE', num: '2 (+1 / FLASH)',
    apply: (s) => { s.pierce += 2; s.piercePerFlash += 1; },
  },
  {
    id: 'cinder', name: 'CINDER', blurb: 'KILLS LEAVE FIRE', num: '2 DPS · GRAZES',
    apply: (s) => { s.cinder = true; },
  },
  {
    // Homing alone measured 0.14x, then 0.46x baseline. The problem is
    // structural: the gun auto-aims, so homing has no upside — it only kills
    // your fuel faster, and the enemies ARE the fuel. So the card now pays
    // heat directly for every hit, which is what a tracer round should do.
    id: 'tracer', name: 'TRACER', blurb: 'SHOTS HOME · HITS HEAT', num: '+0.3 HEAT / HIT',
    apply: (s) => { s.homing = 200; s.damageMult *= 0.7; s.heatPerHit += 0.3; },
  },
  {
    id: 'afterburn', name: 'AFTERBURN', blurb: 'FLASHOVER 4s → 6s', num: 'NO VENT I-FRAMES',
    apply: (s) => { s.flashBody = 6.0; s.flashEndHeat = 55; s.ventIFrames = 0; },
  },
];

export const DRAFT_TIMES = [22, 52, 88, 128];

// ------------------------------------------------------------------- cores

export const CORES = [
  {
    id: 'needle', name: 'NEEDLE', blurb: 'THE BASELINE',
    unlock: null,
    apply: (s) => s,
  },
  {
    id: 'ember', name: 'EMBER', blurb: 'HOT START, FAST BURN',
    unlock: { kind: 'score', value: 25000, text: 'SCORE 25,000 IN ONE RUN' },
    apply: (s) => { s.gainMult *= 1.25; s.decay *= 1.6; s.startHeat = 25; },
  },
  {
    id: 'bulwark', name: 'BULWARK', blurb: 'VENT, DON’T IGNITE',
    unlock: { kind: 'time', value: 90, text: 'SURVIVE 90 SECONDS' },
    apply: (s) => {
      s.grazeRadius = 34; s.ventRadius = 200; s.ventCooldown = 0.65;
      s.gainMult *= 0.85; s.hitbox = 3.5;
    },
  },
];

// Stacking difficulty tiers, unlocked per core.
export const PRESSURE = [
  { tier: 1, text: 'DENSITY ×1.12', apply: (s) => { s.density *= 1.12; } },
  { tier: 2, text: 'ENEMY HP ×1.15', apply: (s) => { s.enemyHp *= 1.15; } },
  { tier: 3, text: 'HEAT DECAY ×1.30', apply: (s) => { s.decay *= 1.3; } },
  { tier: 4, text: 'HUSK AT 55s', apply: (s) => { s.huskFirst = 55; } },
  { tier: 5, text: 'GRAZE RING −4', apply: (s) => { s.grazeRadius -= 4; } },
];

export const RANKS = [
  { name: 'D', at: 0 }, { name: 'C', at: 5000 }, { name: 'B', at: 20000 },
  { name: 'A', at: 60000 }, { name: 'S', at: 120000 }, { name: 'SS', at: 250000 },
  { name: 'SSS', at: 500000 },
];

export const MARKS = [
  { id: 'cold', name: 'COLD BLOODED', text: '60k WITHOUT VENTING' },
  { id: 'redline', name: 'REDLINE', text: '14s ABOVE HEAT 95 IN A RUN' },
  { id: 'furnace', name: 'FURNACE', text: '5 FLASHOVERS IN ONE RUN' },
  { id: 'spark', name: 'SECOND SPARK', text: 'SURVIVE A SPARK, THEN BEAT YOUR BEST' },
  { id: 'ironclad', name: 'IRONCLAD', text: 'SURVIVE 120 SECONDS' },
  { id: 'overdraw', name: 'OVERDRAW', text: 'ONE VENT WORTH 6,000+' },
  { id: 'purist', name: 'PURIST', text: '40k DECLINING EVERY DRAFT' },
  { id: 'devotee', name: 'DEVOTEE', text: '7-DAY DAILY STREAK' },
];

export const MISSION_POOL = [
  { id: 'hold95', text: 'HOLD HEAT 95+ FOR 10s', goal: 10 },
  { id: 'novent60k', text: 'SCORE 60,000 WITHOUT VENTING', goal: 60000 },
  { id: 'flash3', text: 'CAUSE 3 FLASHOVERS IN ONE RUN', goal: 3 },
  { id: 'survive100', text: 'SURVIVE 100 SECONDS', goal: 100 },
  { id: 'husk2', text: 'KILL 2 HUSKS IN ONE RUN', goal: 2 },
  { id: 'vent5k', text: 'LAND A 5,000-POINT VENT', goal: 5000 },
  { id: 'mult10', text: 'HOLD 10× FOR 8 SECONDS', goal: 8 },
  { id: 'graze90', text: 'SPEND 40s ABOVE HEAT 70', goal: 40 },
];

// The default stat block a run starts from, before core/mutator/pressure
// modifiers are folded in.
export function baseStats() {
  return {
    hitbox: SHIP.hitbox,
    grazeRadius: HEAT.grazeRadius,
    gainMult: 1,
    sigmaCap: HEAT.sigmaCap,
    decay: HEAT.decay,
    decayGrace: HEAT.decayGrace,
    multStep: 10,
    heatPerKill: 0,
    heatPerHit: 0,
    startHeat: 0,
    flashAt: HEAT.flashAt,
    flashBody: HEAT.flashBody,
    flashEndHeat: HEAT.flashEndHeat,
    ventRadius: HEAT.ventRadius,
    ventRetain: HEAT.ventRetain,
    ventCooldown: HEAT.ventCooldown,
    ventIFrames: HEAT.ventIFrames,
    fireMult: 1,
    damageMult: 1,
    extraShots: 0,
    pierce: 0,
    piercePerFlash: 0,
    homing: 0,
    cinder: false,
    density: 1,
    enemyHp: 1,
    huskFirst: HUSK.firstAt,
  };
}

export function budgetAt(t) {
  let v = BUDGET[0][1];
  for (const [time, b] of BUDGET) {
    if (t >= time) v = b;
    else break;
  }
  // Past the last table entry the pressure keeps climbing, slowly, forever.
  if (t > 135) v = Math.min(6.5, 4.2 + (t - 135) * 0.02);
  return v;
}

export function eraAt(t) {
  let e = ERAS[0];
  for (const era of ERAS) if (t >= era.t) e = era;
  return e;
}

export function rankFor(score) {
  let r = RANKS[0];
  for (const rank of RANKS) if (score >= rank.at) r = rank;
  return r;
}
