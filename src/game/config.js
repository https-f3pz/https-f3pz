// HOOKFALL — every tunable number.
//
// The world is a fixed 720-wide virtual portrait space so that a number tuned
// once is correct on every phone; game.js scales it to the device. Depth is
// measured in metres at 20 px/m, so terminal velocity (2550 px/s) reads as a
// believable 127 m/s.

export const VW = 720;
export const VH_MIN = 1120;
export const VH_MAX = 1600;
export const PX_PER_M = 20;

// ------------------------------------------------------------------ physics

export const PHYS = {
  // Terminal velocity is a reaction-time budget, not a bragging number. At
  // 2550 px/s the diver crossed a 1558px viewport in 0.6s, which left about
  // 400ms to read and answer a hazard — measured, that produced five-second
  // dives. 1900 px/s gives ~0.8s of sight-line and the same sense of speed.
  gravity: 1150,
  dragFree: 0.00087, // quadratic: terminal = sqrt(g/k) = 1150 px/s
  dragHooked: 0.00030, // the rope lets you keep more speed through an arc
  maxSpeed: 2400, // hard ceiling; without it the reel pump is unbounded
  hookSpeed: 3000,
  hookRange: 420,
  ropeMin: 110,
  ropeMax: 330,
  reelMin: 100,
  reelMax: 380,
  reelRate: 300,
  reelDeadzone: 30,
  snapSpeed: 900, // tangential speed needed for the release boost
  snapBoost: 1.08,
  whipSpeed: 1150, // tangential speed that counts as a whipcrack
  // When a rigid rope goes taut it destroys the velocity component along its
  // length — and you attach with almost all your speed pointing that way, so a
  // physically exact constraint ate the dive: measured, one second of swinging
  // bought 42px of lateral movement in a 500px shaft. This converts part of
  // that would-be-destroyed speed into tangential motion instead. It is not
  // strictly physical; it is the difference between a rope and an anchor.
  swingConvert: 0.45,
  wallBounce: 0.42, // walls are solid but survivable — see below
  wallScrape: 0.55,
};

// Design note: hazards are lethal, walls are not. A 380px pinch taken at
// 4200 px/s gives ~90ms of reaction; making the walls themselves lethal on top
// of that turns the game into memorisation. Instead a wall costs you most of
// your speed, which the Collapse immediately punishes — the same pressure,
// expressed as a setback rather than a restart.

export const COLLAPSE = {
  startGap: 1500, // px above the diver at t=0
  baseSpeed: 620,
  accel: 4.0, // px/s² of extra chase speed per second of run time
  maxLag: 2600, // never falls further behind than this, or it stops mattering
  dreadRange: 700, // HUD/audio dread band
};

export const GRAZE = {
  radius: 34,
  minSpeed: 620,
  window: 2.6,
  maxCombo: 30,
  multPer: 0.12,
  points: 30,
};

// ------------------------------------------------------------------- biomes

export const BIOMES = [
  { at: 0, name: 'THE MOUTH', bgTop: '#0b1020', bgBottom: '#16203a', accent: '#57e0ff', hazard: '#ff3b6b', rock: '#070b16' },
  { at: 2500, name: 'THE VEIN', bgTop: '#1a0b16', bgBottom: '#35102a', accent: '#ff7ae0', hazard: '#ffd23b', rock: '#12060f' },
  { at: 5000, name: 'SALT', bgTop: '#0d1a17', bgBottom: '#123028', accent: '#7bffb0', hazard: '#ff8a3b', rock: '#07120f' },
  { at: 7500, name: 'THE HUM', bgTop: '#140c22', bgBottom: '#2a1145', accent: '#b98cff', hazard: '#ff4d4d', rock: '#0d0718' },
  { at: 10000, name: 'BLACK GLASS', bgTop: '#050507', bgBottom: '#101018', accent: '#ffffff', hazard: '#ff2020', rock: '#030304' },
];

export function biomeAt(metres) {
  let b = BIOMES[0];
  for (const x of BIOMES) if (metres >= x.at) b = x;
  return b;
}

// Blend factor between the current biome and the next, over 400m of depth.
export function biomeBlend(metres) {
  for (let i = BIOMES.length - 1; i >= 0; i--) {
    const b = BIOMES[i];
    if (metres >= b.at) {
      const next = BIOMES[i + 1];
      if (!next) return { from: b, to: b, k: 0 };
      const k = Math.min(1, Math.max(0, (metres - (next.at - 400)) / 400));
      return { from: b, to: next, k };
    }
  }
  return { from: BIOMES[0], to: BIOMES[0], k: 0 };
}

// -------------------------------------------------------------- chasm shape

// The shaft snakes and pinches. Both are pure functions of depth, so the world
// is stateless and any point can be evaluated without generating what's above.
// The shaft snakes AND pinches, and the two have to coexist inside the 720
// world: max wander (100) + max half-gap (250) = 350, which is exactly the
// half-width. Let these drift apart and the walls — and the diver clamped
// between them — slide off the side of the screen.
const MAX_WANDER = 60;
const MAX_HALF = 295;

export function halfGap(y) {
  const m = y / PX_PER_M;
  const base = 295 - Math.min(1, m / 12000) * 80; // 295 -> 215 over 12km
  return Math.max(200, Math.min(MAX_HALF, base + 60 * Math.sin(y / 1700) + 40 * Math.sin(y / 620 + 2.1)));
}

export function centreX(y) {
  return VW / 2 + 42 * Math.sin(y / 1900) + 18 * Math.sin(y / 770 + 1.3);
}

export const CHUNK = 900; // px of depth generated at a time

// ------------------------------------------------------------------ hazards

export const HAZ = { SAW: 0, CRUSHER: 1, SPIKE: 2, ORBIT: 3 };

// ----------------------------------------------------------------- upgrades

export const UPGRADES = [
  {
    id: 'reach', name: 'REACH', blurb: 'HOOK RANGE',
    costs: [150, 400, 900, 1800, 3200],
    value: (t) => 420 + t * 44, unit: (t) => `${420 + t * 44} px`,
  },
  {
    id: 'snap', name: 'SNAP', blurb: 'RELEASE BOOST',
    costs: [150, 400, 900, 1800, 3200],
    value: (t) => 1.08 + t * 0.016, unit: (t) => `+${Math.round((0.08 + t * 0.016) * 100)}%`,
  },
  {
    id: 'winch', name: 'WINCH', blurb: 'REEL SPEED',
    costs: [150, 400, 900, 1800, 3200],
    value: (t) => 300 + t * 44, unit: (t) => `${300 + t * 44} px/s`,
  },
  {
    id: 'wax', name: 'WAX', blurb: 'SWING DRAG',
    costs: [150, 400, 900, 1800, 3200],
    value: (t) => 0.00024 - t * 0.000024, unit: (t) => `${(100 - t * 10).toFixed(0)}%`,
  },
];

export const MISSION_POOL = [
  { id: 'graze40', text: 'GRAZE 40 TIMES IN ONE DIVE', goal: 40 },
  { id: 'depth6k', text: 'REACH 6,000 m', goal: 6000 },
  { id: 'gems12', text: 'COLLECT 12 GEMS', goal: 12 },
  { id: 'chain20', text: 'HOLD A 20 CHAIN', goal: 20 },
  { id: 'whip15', text: 'LAND 15 WHIPCRACKS', goal: 15 },
  { id: 'speed4k', text: 'BREAK 4,000 px/s', goal: 4000 },
  { id: 'noreel', text: 'REACH 3,000 m WITHOUT REELING', goal: 3000 },
  { id: 'gate3', text: 'REACH BLACK GLASS (10,000 m)', goal: 10000 },
];

export const RANKS = [
  { name: 'DRIFTER', at: 0 }, { name: 'DIVER', at: 1500 }, { name: 'PLUMMET', at: 4000 },
  { name: 'FALLER', at: 8000 }, { name: 'VOIDWALKER', at: 14000 }, { name: 'ABYSSAL', at: 22000 },
];

export function rankFor(m) {
  let r = RANKS[0];
  for (const x of RANKS) if (m >= x.at) r = x;
  return r;
}

export function nextRank(m) {
  for (const r of RANKS) if (r.at > m) return r;
  return null;
}

export function upgradeValue(save, id) {
  const u = UPGRADES.find((x) => x.id === id);
  const tier = save?.upgrades?.[id] ?? 0;
  return u.value(tier);
}
