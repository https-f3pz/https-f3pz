// Persistence layer. localStorage can throw (private mode, quota, disabled
// cookies) so every access is guarded and the game degrades to in-memory —
// you can still play, the numbers just don't survive a reload.

const KEY = 'hookfall.v1';

const memory = new Map();

const backend = (() => {
  try {
    const probe = '__hookfall_probe__';
    localStorage.setItem(probe, '1');
    localStorage.removeItem(probe);
    return localStorage;
  } catch {
    return {
      getItem: (k) => (memory.has(k) ? memory.get(k) : null),
      setItem: (k, v) => memory.set(k, String(v)),
      removeItem: (k) => memory.delete(k),
    };
  }
})();

export function defaults() {
  return {
    v: 1,
    best: 0,           // deepest dive, in metres — the headline record
    bestScore: 0,
    bestCombo: 0,
    runs: 0,
    totalDepth: 0,
    gems: 0,
    shards: 0,
    upgrades: { reach: 0, snap: 0, winch: 0, wax: 0 },
    depths20: [],
    missions: null,
    missionSets: 0,
    daily: { date: null, depth: 0, score: 0, streak: 0, locked: false, history: [] },
    settings: {
      sound: true,
      music: true,
      haptics: true,
      reduceShake: 1,
      reduceGlow: false,
    },
    seenTips: {},
  };
}

function isPlain(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

function deepMerge(base, patch) {
  if (!isPlain(patch)) return patch;
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const k of Object.keys(patch)) {
    out[k] = isPlain(out[k]) && isPlain(patch[k]) ? deepMerge(out[k], patch[k]) : patch[k];
  }
  return out;
}

// Merges in place. The game holds a long-lived reference to the save object,
// so replacing it on every write would silently strand every holder — this
// keeps one object identity for the lifetime of the page.
function mergeInto(base, patch) {
  for (const k of Object.keys(patch)) {
    if (isPlain(base[k]) && isPlain(patch[k])) mergeInto(base[k], patch[k]);
    else base[k] = patch[k];
  }
  return base;
}

let cache = null;

export function load() {
  if (cache) return cache;
  let parsed = null;
  try {
    const raw = backend.getItem(KEY);
    if (raw) parsed = JSON.parse(raw);
  } catch {
    parsed = null; // corrupt save: start clean rather than crash on boot
  }
  // Merge onto defaults so a save written by an older build gains new fields
  // instead of leaving `undefined` holes all over the game.
  cache = parsed && typeof parsed === 'object' ? deepMerge(defaults(), parsed) : defaults();
  return cache;
}

let flushTimer = 0;
let dirty = false;

export function save(patch) {
  const c = load();
  if (patch && patch !== c) mergeInto(c, patch);
  dirty = true;
  // Coalesce writes — localStorage is synchronous and can cost a frame.
  if (flushTimer) return cache;
  flushTimer = setTimeout(flushNow, 250);
  return cache;
}

export function flushNow() {
  clearTimeout(flushTimer);
  flushTimer = 0;
  // Backgrounding fires visibilitychange and pagehide back to back; without
  // this the app does two or three synchronous serialise-and-write cycles at
  // exactly the moment the OS is trying to suspend it.
  if (!dirty) return;
  dirty = false;
  try {
    backend.setItem(KEY, JSON.stringify(cache || defaults()));
  } catch {
    /* quota or disabled storage — the run still plays, it just won't persist */
  }
}

export function reset() {
  cache = defaults();
  dirty = true;
  flushNow();
  return cache;
}

// Persist immediately when the app is backgrounded — mobile browsers kill
// pages without warning and `beforeunload` is unreliable on iOS.
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushNow();
  });
  window.addEventListener('pagehide', flushNow);
}
