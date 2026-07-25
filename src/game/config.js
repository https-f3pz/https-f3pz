// REDSHIFT — every tunable number.
//
// The whole game is one idea: you fly down a tube in real perspective, and
// your velocity distorts the projection. Faster means a wider field of view,
// walls that bow outward, geometry that smears along its own motion, and
// colour that Doppler-shifts blue ahead / red behind.
//
// Because speed is also the score, the distortion IS the readout — and the
// better you play, the harder the world becomes to read.

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

// ------------------------------------------------------------------ physics

export const SPEED = {
  start: 900,
  min: 620,
  max: 5200,

  // The bore pulls harder the deeper you are: a speed FLOOR that rises with
  // distance. Without it the economy self-stabilises — a gate bonus paid per
  // plane crossed is worth more per second the faster you go, so gains and
  // decay balance at `decay x spacing / gateGain` and the view stops distorting
  // at whatever that happens to be. The floor is what makes the distortion
  // escalate across a run, which is the whole premise.
  // The floor tops out below the shatter point's reach only slowly, so a
  // perfectly clean pilot still eventually meets a speed their hull cannot
  // take a hit at — but everything above the floor has to be earned by
  // grazing, which is where skill and style show up.
  pullCap: 0.90, // the floor asymptotes here, as a fraction of max
  pullK: 65000, // e-folding distance of the ramp
  pullBack: 0.25, // per second: how hard you are dragged back up to the floor

  decay: 190, // units/sec² bled from anything above the floor
  grazeGain: 240, // per near miss — the only real surplus
  gateGain: 45, // per gate: not quite enough to hold station on its own
  hitLoss: 0.72, // multiplier applied on a clip — the real cost is the crack

  // Failure. Clipping a wall is survivable while you are slow and the picture
  // is honest; at speed, with a view you can no longer trust, it is not.
  shatter: 0.86, // warp at which a clip becomes fatal
  crack: 0.03, // every clip lowers that threshold hard
  // ...and the hull tires on its own, with TIME. Without this, refusing to go
  // fast is simply the best strategy — a slow pilot survives longer and
  // travels further for it, and the whole distortion becomes optional.
  fatigue: 0.0062, // per second
  // A near miss is the ONLY thing that works the fatigue back out. That single
  // rule closes the loop: flying close to the wall is what makes you fast and
  // what keeps you alive, and playing safe is a slow bleed to a hull that can
  // no longer take the speed the bore is pulling you to.
  anneal: 0.016, // per graze
};

/**
 * The speed the bore is pulling you to at this distance. A pure function of
 * distance so the track generator can use it too, and stay deterministic.
 */
export function speedFloor(dist) {
  const top = SPEED.max * SPEED.pullCap;
  return SPEED.start + (top - SPEED.start) * (1 - Math.exp(-dist / SPEED.pullK));
}

export const SHIP = {
  // Angular position around the bore, in radians. One thumb, one axis.
  turnRate: 5.6, // rad/sec at full deflection
  dragGain: 0.0135, // radians per pixel of thumb travel
  maxStep: 0.42, // rad per substep — stops a flick teleporting you
  radius: 0.16, // angular half-width for collision
  z: 0, // the player plane is always z = 0
};

// How hard the projection lies, as a function of speed (0..1).
export const WARP = {
  fovMin: 620, // focal length at rest — a calm, narrow view
  fovMax: 1180, // and at full speed: much wider, everything rushes past
  barrel: 0.42, // radial bow of the walls at full speed
  smear: 0.55, // how far geometry streaks along its own motion
  doppler: 0.95, // strength of the blue-ahead / red-behind shift
  roll: 0.10, // camera roll induced by turning
  shakeAt: 0.72, // speed fraction where the frame starts to buzz
};

export const GRAZE = {
  window: 2.4, // seconds before a chain lapses
  maxCombo: 24,
  multPer: 0.14,
  // Radians of clearance, measured from the hull's edge, that counts as a near
  // miss. A single open sector is 0.79 rad wide and the hull eats 0.32 of
  // that, so this is roughly the outer half of the tightest gap in the game.
  angle: 0.12,
};

// ------------------------------------------------------------------- zones
// Each zone is a palette plus a rule change. Crossing one is a full-screen
// event, and "I have never seen the last one" is the retention hook.

export const ZONES = [
  { at: 0, name: 'CALIBRATION', wall: '#1b3a6b', edge: '#57e0ff', hazard: '#ff3b6b', fog: '#050912' },
  { at: 25000, name: 'DRIFT', wall: '#123a44', edge: '#5affd0', hazard: '#ff8a3b', fog: '#04100f' },
  { at: 70000, name: 'CASCADE', wall: '#3a1550', edge: '#c07aff', hazard: '#ffd23b', fog: '#0a0518' },
  { at: 140000, name: 'REDSHIFT', wall: '#5a1330', edge: '#ff7ae0', hazard: '#ff2020', fog: '#12030a' },
  { at: 230000, name: 'EVENT HORIZON', wall: '#101018', edge: '#ffffff', hazard: '#ff2020', fog: '#000000' },
];

const BLEND = 6000; // units of crossfade before a zone boundary

export function zoneAt(dist) {
  let z = ZONES[0];
  for (const x of ZONES) if (dist >= x.at) z = x;
  return z;
}

export function zoneBlend(dist) {
  for (let i = ZONES.length - 1; i >= 0; i--) {
    const z = ZONES[i];
    if (dist >= z.at) {
      const next = ZONES[i + 1];
      if (!next) return { from: z, to: z, k: 0 };
      return { from: z, to: next, k: Math.min(1, Math.max(0, (dist - (next.at - BLEND)) / BLEND)) };
    }
  }
  return { from: ZONES[0], to: ZONES[0], k: 0 };
}

// --------------------------------------------------------------- obstacles

export const OBS = { WALLS: 0, SPINNER: 1, IRIS: 2, COMB: 3 };

// World units of track generated at a time. Each chunk is one pattern, so this
// also sets how long you spend in a single idea — around six seconds early on,
// dropping to under two once the bore is really moving.
export const CHUNK = 6000;

export const UPGRADES = [
  {
    id: 'grip', name: 'GRIP', blurb: 'TURN RATE',
    costs: [120, 320, 700, 1400, 2600],
    value: (t) => 5.6 + t * 0.55, unit: (t) => `${(5.6 + t * 0.55).toFixed(1)} rad/s`,
  },
  {
    id: 'lens', name: 'LENS', blurb: 'WARP ONSET',
    costs: [120, 320, 700, 1400, 2600],
    // Higher tiers delay the distortion, trading spectacle for readability.
    value: (t) => 1 - t * 0.09, unit: (t) => `${100 - t * 9}% DISTORTION`,
  },
  {
    id: 'intake', name: 'INTAKE', blurb: 'GRAZE VALUE',
    costs: [120, 320, 700, 1400, 2600],
    value: (t) => 240 + t * 44, unit: (t) => `+${240 + t * 44} SPEED`,
  },
  {
    id: 'hull', name: 'HULL', blurb: 'SHATTER POINT',
    costs: [120, 320, 700, 1400, 2600],
    // How much warp the hull can take a hit at. This is the run-length dial:
    // everything else being equal, you die at the first clip past this number.
    value: (t) => SPEED.shatter + t * 0.028,
    unit: (t) => `SHATTER AT ${Math.round((SPEED.shatter + t * 0.028) * 100)}%`,
  },
];

export const MISSION_POOL = [
  { id: 'dist100k', text: 'TRAVEL 100,000 UNITS', goal: 100000 },
  { id: 'chain20', text: 'HOLD A 20 CHAIN', goal: 20 },
  { id: 'top4k', text: 'REACH 4,000 SPEED', goal: 4000 },
  { id: 'clean40', text: 'CLEAR 40 GATES WITHOUT A CLIP', goal: 40 },
  { id: 'zone3', text: 'REACH REDSHIFT (140,000)', goal: 140000 },
  { id: 'graze60', text: 'GRAZE 60 TIMES IN ONE RUN', goal: 60 },
];

export const RANKS = [
  { name: 'IDLE', at: 0 }, { name: 'COASTING', at: 40000 }, { name: 'PLANING', at: 90000 },
  { name: 'SUPERSONIC', at: 160000 }, { name: 'BLUESHIFT', at: 260000 }, { name: 'LIGHTLIKE', at: 400000 },
];

export function rankFor(d) {
  let r = RANKS[0];
  for (const x of RANKS) if (d >= x.at) r = x;
  return r;
}

export function upgradeValue(save, id) {
  const u = UPGRADES.find((x) => x.id === id);
  return u.value(save?.upgrades?.[id] ?? 0);
}
