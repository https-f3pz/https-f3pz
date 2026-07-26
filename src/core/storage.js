// Persistence layer. localStorage can throw (private mode, quota, disabled
// cookies) so every access is guarded and the game degrades to in-memory —
// you can still play, the numbers just don't survive a reload.

const KEY = 'redshift.v1';

const memory = new Map();

const backend = (() => {
  try {
    const probe = '__redshift_probe__';
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

export const SAVE_VERSION = 2;

export function defaults() {
  return {
    v: SAVE_VERSION,
    // The whole economy, serialised by game/economy.js. Every unbounded number
    // in here is a STRING, never a JSON number: JSON.stringify(Infinity) is
    // `null`, and one null merged over a default silently poisons every
    // comparison downstream for the life of the save.
    economy: null,
    // Wall clock, monotonic sample, high-water mark and away budget.
    clock: null,
    settings: {
      sound: true,
      music: true,
      haptics: true,
      reduceShake: 1,
      reduceGlow: false,
    },
  };
}

/**
 * Bring an older save forward. Runs BEFORE the merge onto defaults — merging
 * first would let v1's numeric fields sit underneath v2's string-Big fields
 * and produce a save that is neither.
 *
 * v1 was a different game entirely (a reflex arcade run). Nothing in its
 * progress maps onto an idle economy, so only the settings survive — but they
 * DO survive, which is why the storage key is not bumped. Changing the key
 * orphans the blob and silently discards the player's sound, music, haptics
 * and accessibility choices along with it.
 */
function migrate(parsed) {
  if (!parsed || typeof parsed !== 'object') return null;
  const v = Number(parsed.v) || 1;
  if (v >= SAVE_VERSION) return parsed;
  return { v: SAVE_VERSION, settings: parsed.settings ?? {} };
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
  const migrated = migrate(parsed);
  cache = migrated ? deepMerge(defaults(), migrated) : defaults();
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
