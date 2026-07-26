// REDSHIFT: DEEP FIELD — every tunable number.
//
// You are falling down a bore that has no bottom. Every machine you build makes
// the fall faster, until the picture itself can no longer keep up — and then you
// collapse the whole apparatus into light and fall again from deeper.
//
// ---------------------------------------------------------------------------
// THE INVARIANT. READ THIS BEFORE CHANGING ANY NUMBER IN THIS FILE.
// ---------------------------------------------------------------------------
// A ladder in which tier k produces tier k-1, and in which every MILE_EVERY
// purchases multiply a tier's output by MILE_MULT, feeds back into itself. The
// gain of that loop is
//
//     g(S) = (log10(MILE_MULT) / MILE_EVERY) * sum_{k=1..S} 1 / log10(r_k)
//
// and depth then grows as t^P where P = S / (1 - g). If g ever reaches 1 the
// economy diverges in finite time and the game is over in an afternoon.
//
// With the values below: g(8) = 0.359, g(16) = 0.558, P(8) = 12.5, P(16) = 36.2,
// and the prestige feedback exponent is 0.835 against a ceiling of 1.
//
// THREE RULES, FROZEN:
//   1. Nothing may ever change MILE_MULT, MILE_EVERY or any ratio(k). There is
//      deliberately NO cost-reduction upgrade in this game, because lowering a
//      ratio RAISES g — a 2% cut across the board tips it over 1.
//   2. Any multiplier bought with a prestige currency at geometric cost for
//      geometric benefit adds log(benefit)/log(cost) to the feedback exponent
//      and MUST be hard-capped. That is why OVERDRIVE stops at 12 levels.
//   3. No unbounded Big lifetime sum may drive anything visual or structural.
//      See rule 3 in economy.js for why, and tools/coretest.mjs for the proof.
//
// tools/balance.mjs asserts all three on every run.

export const VW = 720; // virtual width; game.js scales it to the device
export const VH_MIN = 1120;
export const VH_MAX = 1600;

// ----------------------------------------------------------------- the tube

export const TUBE = {
  sides: 8, // an octagonal bore reads cleanly at any distortion
  radius: 300, // world units from axis to wall
  near: 240, // camera sits this far back from the player plane
  far: 4200, // draw distance in z
  ringGap: 340, // spacing of the structural rings
};

// How hard the projection lies, as a function of the cycle (0..1).
export const WARP = {
  fovMin: 620, // focal length at rest — a calm, narrow view
  fovMax: 1180, // and at full warp: much wider, everything rushes past
  barrel: 0.42, // radial bow of the walls
  smear: 0.55, // how far geometry streaks along its own motion
  doppler: 0.95, // strength of the blue-ahead / red-behind shift
  roll: 0.10, // camera roll induced by turning
  shakeAt: 0.72, // warp at which the frame starts to buzz
};

// Speed is derived from warp and exists only to drive the renderer. The bounds
// are what keep render.js's vignette radius positive and its ring spacing on
// the power-of-two ladder.
export const SPEED = { min: 620, span: 4300 };

// ------------------------------------------------------------ the economy

export const LADDER = [
  'INTAKE', 'IMPELLER', 'COMPRESSOR', 'LATTICE', 'RESONATOR', 'COLLIMATOR',
  'SINGULARITY', 'PRIME MOVER', 'AXIS', 'VOID DRAW', 'CATENARY', 'NULL FORGE',
  'RECURSION', 'WORLDLINE', 'ASYMPTOTE', 'LIMIT',
];

export const TIERS = { base: 8, max: 16 };

export const MILE_MULT = 1.20; // FROZEN — see the invariant above
export const MILE_EVERY = 20; // FROZEN — see the invariant above

export const PEXP = 0.32; // prestige gain exponent (collapse and dilate alike)
export const TEXP = 0.32;
export const DRIFT_MULT = 3; // per omega allocated to DRIFT

export const OVERDRIVE = { levels: 12, mult: 2.2, base: 25, ratio: 5 };

// Prestige gates, written as literal Bigs so config imports nothing. Every Big
// operation returns a fresh pair and never mutates its arguments, so sharing
// these constants is safe.
export const GATE = {
  collapse: { m: 1, e: 7 }, // depth 1e7
  dilate: { m: 1, e: 6 }, // lifetime photons 1e6
  horizonDecade: 5, // one omega per decade of tau past this
};

export const AUTO = {
  driveBase: 3, // AUTO-DRIVE k costs 3^(k-1) photons
  bulk: 50,
  governor: 500,
  collapse: 5000,
  dilate: 100, // tau, not photons
  horizonDefault: 300, // PRIME's planning horizon before any absence is known
  horizonMin: 120,
  horizonMax: 12 * 3600,
};

/** GOVERNOR reserve fractions: depth held back from the cheap tiers. */
export const GOV_STEPS = [0, 0.25, 0.5, 0.75];

/** Auto-prestige thresholds: fire when the pending award is this many times the bank. */
export const PRESTIGE_STEPS = [2, 5, 10, 50];

export const AWAY = {
  baseCap: 36 * 3600,
  perStasis: 24 * 3600,
  stasisMax: 7, // -> 204 hours
  chunk: 60, // seconds per offline chunk; below this the curve is flat
  refill: 1.25, // budget bucket refill rate per real second
};

export const CHALLENGES = [
  { id: 'coldbore', name: 'COLD BORE', handicap: 'TIERS 5+ LOCKED', reward: '+4 FREE IN TIERS 1-4' },
  { id: 'deadreck', name: 'DEAD RECKONING', handicap: 'NO AUTOBUYERS', reward: 'PHOTON GAIN x1.5' },
  { id: 'flattime', name: 'FLAT TIME', handicap: 'CLOCK FORCED TO x1', reward: 'CLOCK COEFFICIENT +0.05' },
  { id: 'nomiles', name: 'NO MILESTONES', handicap: 'ALL MILESTONES OFF', reward: '+1 FREE MILESTONE EVERYWHERE' },
  { id: 'singlefile', name: 'SINGLE FILE', handicap: 'GOVERNOR FORCED TO 75%', reward: '+2 FREE IN EVERY TIER' },
];

// --------------------------------------------------------------- palettes
//
// The old game had five fixed zones on a distance axis that froze forever once
// you passed the last one. An idle game runs for months, so the palette cycles
// instead: eight of them, and the whole set rotates 47 degrees of hue each
// complete cycle. gcd(47, 360) = 1, so it takes 360 cycles to repeat exactly.

export const PALETTES = [
  { name: 'CALIBRATION', wall: '#1b3a6b', edge: '#57e0ff', hazard: '#ff3b6b', fog: '#050912' },
  { name: 'DRIFT', wall: '#123a44', edge: '#5affd0', hazard: '#ff8a3b', fog: '#04100f' },
  { name: 'CASCADE', wall: '#3a1550', edge: '#c07aff', hazard: '#ffd23b', fog: '#0a0518' },
  { name: 'DEEP FIELD', wall: '#5a1330', edge: '#ff7ae0', hazard: '#ff2020', fog: '#12030a' },
  { name: 'HALIDE', wall: '#123c2a', edge: '#8dff6a', hazard: '#ffe14f', fog: '#040f08' },
  { name: 'COBALT', wall: '#101c56', edge: '#6a8dff', hazard: '#ff6ad5', fog: '#03060f' },
  { name: 'EMBER', wall: '#5a2a10', edge: '#ffb14f', hazard: '#ff4020', fog: '#100603' },
  { name: 'EVENT HORIZON', wall: '#101018', edge: '#ffffff', hazard: '#ff2020', fog: '#000000' },
];

/** Bands are 4000 units of the synthetic palette coordinate wide. */
export const BAND_SPAN = 4000;
const CROSSFADE = 0.18; // fraction of a band spent blending into the next

export function paletteIndex(dist) {
  return Math.floor(dist / BAND_SPAN);
}

/**
 * Palette at a synthetic coordinate, with a crossfade into the next and a hue
 * rotation that advances once per complete cycle of eight.
 */
export function paletteBlend(dist) {
  const i = Math.floor(dist / BAND_SPAN);
  const f = dist / BAND_SPAN - i;
  const n = PALETTES.length;
  const from = PALETTES[((i % n) + n) % n];
  const to = PALETTES[(((i + 1) % n) + n) % n];
  const k = f > 1 - CROSSFADE ? (f - (1 - CROSSFADE)) / CROSSFADE : 0;
  return {
    from,
    to,
    k,
    hue: Math.floor(i / n) * 47,
    name: k > 0.5 ? to.name : from.name,
  };
}
