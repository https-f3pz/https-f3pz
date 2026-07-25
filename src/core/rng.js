// Deterministic, seedable RNG. Every run gets a seed so a run can be replayed
// or shared, and so daily challenges are identical for everyone.

export function hashSeed(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

// mulberry32 — small, fast, good enough spectral properties for a game.
export function makeRng(seed) {
  let a = (typeof seed === 'string' ? hashSeed(seed) : seed >>> 0) || 1;

  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  next.int = (min, max) => min + Math.floor(next() * (max - min + 1));
  next.range = (min, max) => min + next() * (max - min);
  next.chance = (p) => next() < p;
  next.pick = (arr) => arr[Math.floor(next() * arr.length)];
  next.sign = () => (next() < 0.5 ? -1 : 1);
  next.angle = () => next() * Math.PI * 2;

  // Fisher-Yates, in place.
  next.shuffle = (arr) => {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(next() * (i + 1));
      const t = arr[i];
      arr[i] = arr[j];
      arr[j] = t;
    }
    return arr;
  };

  // Weighted pick. `weightOf` returns a non-negative number per item.
  next.weighted = (arr, weightOf) => {
    let total = 0;
    for (let i = 0; i < arr.length; i++) total += weightOf(arr[i], i);
    if (total <= 0) return arr[Math.floor(next() * arr.length)];
    let r = next() * total;
    for (let i = 0; i < arr.length; i++) {
      r -= weightOf(arr[i], i);
      if (r <= 0) return arr[i];
    }
    return arr[arr.length - 1];
  };

  return next;
}

// Human-typeable seed words, so a good run can be written down.
const WORDS = 'ARC BOLT CAGE DUSK EMBER FLUX GLOW HALO IRIS JOLT KILN LUME MOTE NOVA ONYX PRISM QUARK RIFT SPARK TIDE UMBRA VEIL WISP XENON YIELD ZEPHYR'.split(' ');

export function randomSeedWord(rand = Math.random) {
  const a = WORDS[Math.floor(rand() * WORDS.length)];
  const n = 100 + Math.floor(rand() * 900);
  return `${a}-${n}`;
}
