// All sound is synthesized at runtime — no audio files, so the whole game
// still works from a cold cache with the radio off.

let ctx = null;
let master = null;
let sfxBus = null;
let musicBus = null;
let ready = false;
let settings = { sound: true, music: true };

// Mobile browsers refuse to start an AudioContext outside a user gesture, and
// iOS additionally suspends it whenever the tab loses focus.
export function unlock() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return false;
    ctx = new AC();

    master = ctx.createGain();
    master.gain.value = 0.9;
    master.connect(ctx.destination);

    // A gentle limiter keeps stacked explosions from clipping into crackle.
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -12;
    comp.knee.value = 18;
    comp.ratio.value = 6;
    comp.attack.value = 0.003;
    comp.release.value = 0.2;
    comp.connect(master);

    sfxBus = ctx.createGain();
    sfxBus.gain.value = 0.75;
    sfxBus.connect(comp);

    musicBus = ctx.createGain();
    musicBus.gain.value = 0.0;
    musicBus.connect(comp);

    ready = true;
  }
  if (ctx.state === 'suspended') ctx.resume();
  return ready;
}

export function configure(s) {
  const wantedMusic = settings.music;
  settings = { ...settings, ...s };
  if (!ready) return;
  sfxBus.gain.setTargetAtTime(settings.sound ? 0.75 : 0, ctx.currentTime, 0.02);
  musicBus.gain.setTargetAtTime(settings.music ? musicTarget : 0, ctx.currentTime, 0.15);

  // Muting the bus is not enough: the sequencer would keep building and
  // tearing down thousands of oscillator nodes per run that nobody can hear,
  // plus a 60ms setTimeout chain running for the whole session.
  if (!settings.music && musicOn) stopMusic(0.15, true);
  else if (settings.music && !wantedMusic && musicWanted) startMusic();
}

export function suspend() {
  if (ready && ctx.state === 'running') ctx.suspend();
}
export function resume() {
  if (ready && ctx.state === 'suspended') ctx.resume();
}

const now = () => (ctx ? ctx.currentTime : 0);

// ---------------------------------------------------------------- primitives

function envGain(bus, peak, attack, decay, t0) {
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(Math.max(0.0001, peak), t0 + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + attack + decay);
  g.connect(bus);
  return g;
}

// A pitched blip with optional glide. The workhorse behind most feedback.
export function tone({
  freq = 440,
  freq2 = null,
  type = 'square',
  dur = 0.12,
  attack = 0.005,
  gain = 0.3,
  delay = 0,
  detune = 0,
  bus = null,
} = {}) {
  if (!ready || !settings.sound) return;
  const t0 = now() + delay;
  const osc = ctx.createOscillator();
  osc.type = type;
  osc.detune.value = detune;
  osc.frequency.setValueAtTime(freq, t0);
  if (freq2 && freq2 !== freq) {
    osc.frequency.exponentialRampToValueAtTime(Math.max(1, freq2), t0 + dur);
  }
  const g = envGain(bus || sfxBus, gain, attack, Math.max(0.01, dur - attack), t0);
  osc.connect(g);
  osc.start(t0);
  osc.stop(t0 + dur + 0.05);
}

let noiseBuffer = null;
function getNoise() {
  if (noiseBuffer) return noiseBuffer;
  const len = Math.floor(ctx.sampleRate * 0.5);
  noiseBuffer = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = noiseBuffer.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  return noiseBuffer;
}

// Filtered noise burst — impacts, shatters, whooshes.
export function noise({
  dur = 0.18,
  gain = 0.3,
  cutoff = 1800,
  cutoff2 = null,
  q = 1,
  filter = 'lowpass',
  attack = 0.002,
  delay = 0,
} = {}) {
  if (!ready || !settings.sound) return;
  const t0 = now() + delay;
  const src = ctx.createBufferSource();
  src.buffer = getNoise();
  src.playbackRate.value = 1;

  const biq = ctx.createBiquadFilter();
  biq.type = filter;
  biq.Q.value = q;
  biq.frequency.setValueAtTime(cutoff, t0);
  if (cutoff2) biq.frequency.exponentialRampToValueAtTime(Math.max(40, cutoff2), t0 + dur);

  const g = envGain(sfxBus, gain, attack, Math.max(0.01, dur - attack), t0);
  src.connect(biq);
  biq.connect(g);
  src.start(t0);
  src.stop(t0 + dur + 0.05);
}

// ------------------------------------------------------------------ the kit

const SEMI = (n) => Math.pow(2, n / 12);

export const sfx = {
  uiMove: () => tone({ freq: 520, type: 'square', dur: 0.045, gain: 0.12 }),

  uiConfirm: () => {
    tone({ freq: 523, type: 'triangle', dur: 0.09, gain: 0.2 });
    tone({ freq: 784, type: 'triangle', dur: 0.12, gain: 0.16, delay: 0.06 });
  },

  uiBack: () => tone({ freq: 400, freq2: 260, type: 'triangle', dur: 0.1, gain: 0.16 }),

  hookFire: () => {
    tone({ freq: 880, freq2: 220, type: 'square', dur: 0.09, gain: 0.14 });
    noise({ dur: 0.03, gain: 0.10, cutoff: 3000 });
  },

  whiff: () => noise({ dur: 0.12, gain: 0.08, cutoff: 900, cutoff2: 300 }),

  // The rope biting is the most important single sound in the game: it is the
  // moment control transfers from gravity to you.
  attach: () => {
    tone({ freq: 180, freq2: 60, type: 'sine', dur: 0.14, gain: 0.3 });
    noise({ dur: 0.04, gain: 0.18, cutoff: 2600, cutoff2: 700 });
  },

  release: () => tone({ freq: 300, freq2: 520, type: 'triangle', dur: 0.07, gain: 0.1 }),

  whipcrack: () => {
    noise({ dur: 0.12, gain: 0.3, cutoff: 4000, cutoff2: 300, filter: 'bandpass', q: 1.1 });
    tone({ freq: 90, freq2: 40, type: 'sine', dur: 0.22, gain: 0.3 });
  },

  // Grazes climb a pentatonic ladder, so a chain plays an ascending melody
  // over the music rather than repeating one blip.
  graze: (combo = 0) => {
    const SCALE = [0, 3, 5, 7, 10];
    const n = SCALE[combo % 5] + 12 * Math.min(3, Math.floor(combo / 5));
    tone({ freq: 660 * SEMI(n), type: 'triangle', dur: 0.07, gain: 0.16 });
  },

  gem: () => {
    tone({ freq: 880, type: 'sine', dur: 0.06, gain: 0.16 });
    tone({ freq: 1320, type: 'sine', dur: 0.08, gain: 0.13, delay: 0.03 });
  },

  scrape: () => noise({ dur: 0.22, gain: 0.22, cutoff: 1800, cutoff2: 380, filter: 'bandpass', q: 0.8 }),

  milestone: () => {
    [0, 7, 12].forEach((n, i) =>
      tone({ freq: 523 * SEMI(n), type: 'triangle', dur: 0.2, gain: 0.15, delay: i * 0.055 })
    );
  },

  biome: () => {
    [0, 5, 9, 12, 16].forEach((n, i) =>
      tone({ freq: 392 * SEMI(n), type: 'sine', dur: 0.45, gain: 0.16, delay: i * 0.09 })
    );
  },

  best: () => {
    [0, 4, 7, 12].forEach((n, i) =>
      tone({ freq: 523 * SEMI(n), type: 'triangle', dur: 0.3, gain: 0.18, delay: i * 0.07 })
    );
  },

  death: () => {
    tone({ freq: 400, freq2: 50, type: 'sawtooth', dur: 0.7, gain: 0.3 });
    noise({ dur: 0.8, gain: 0.26, cutoff: 2400, cutoff2: 120 });
  },
};

// ---------------------------------------------------------- swing whoosh
// The signature voice, and the only persistent one: a single noise source
// through a single bandpass, created once and driven purely by param ramps.
// Allocating nodes per frame for this would be audible as clicks and would
// churn the audio thread; instead the rope literally sings as you accelerate.

let whooshSrc = null;
let whooshGain = null;
let whooshFilter = null;

function ensureWhoosh() {
  if (whooshSrc || !ready) return;
  whooshSrc = ctx.createBufferSource();
  whooshSrc.buffer = getNoise();
  whooshSrc.loop = true;
  whooshFilter = ctx.createBiquadFilter();
  whooshFilter.type = 'bandpass';
  whooshFilter.Q.value = 1.1;
  whooshFilter.frequency.value = 400;
  whooshGain = ctx.createGain();
  whooshGain.gain.value = 0;
  whooshSrc.connect(whooshFilter);
  whooshFilter.connect(whooshGain);
  whooshGain.connect(sfxBus);
  whooshSrc.start();
}

/** speed in px/s; gain ramps in over 600..2600, cutoff tracks speed. */
export function setWhoosh(speed) {
  if (!ready || !settings.sound) return;
  ensureWhoosh();
  if (!whooshGain) return;
  const k = Math.max(0, Math.min(1, (speed - 600) / 2000));
  whooshGain.gain.setTargetAtTime(k * 0.11, ctx.currentTime, 0.05);
  whooshFilter.frequency.setTargetAtTime(400 + 0.35 * speed, ctx.currentTime, 0.05);
}

export function stopWhoosh() {
  if (whooshGain && ready) whooshGain.gain.setTargetAtTime(0, ctx.currentTime, 0.05);
}

// -------------------------------------------------------------- music layer
// A tiny generative sequencer: a rolling bass pulse plus an arpeggio whose
// register and density rise with intensity. Scheduled ahead of the audio clock
// so it never stutters when the main thread is busy drawing.

const SCALE = [0, 3, 5, 7, 10]; // minor pentatonic — hard to make sound wrong
const ROOT = 55; // A1

let musicTarget = 0.5;
let musicOn = false;
// What the game asked for, independent of whether the setting allows it —
// so re-enabling music mid-run resumes instead of waiting for the next run.
let musicWanted = false;
let step = 0;
let nextNoteTime = 0;
let schedTimer = 0;
let intensity = 0;

function scheduleStep(t, i) {
  const bar = i % 16;

  // Bass: root pulse on the downbeats.
  if (bar % 4 === 0) {
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.setValueAtTime(180 + intensity * 500, t);
    f.Q.value = 6;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.4, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.34);
    o.frequency.setValueAtTime(ROOT * (bar === 8 ? SEMI(5) : 1), t);
    o.connect(f);
    f.connect(g);
    g.connect(musicBus);
    o.start(t);
    o.stop(t + 0.4);
  }

  // Arp: denser and brighter as the run heats up.
  const density = 0.25 + intensity * 0.6;
  if ((i * 2654435761) % 100 < density * 100) {
    const oct = 3 + (intensity > 0.6 && bar % 8 === 6 ? 1 : 0);
    const n = SCALE[(i * 3) % SCALE.length] + 12 * oct;
    const o = ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.setValueAtTime(ROOT * SEMI(n), t);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.16, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
    o.connect(g);
    g.connect(musicBus);
    o.start(t);
    o.stop(t + 0.22);
  }

  // Hat: only once things get busy, to mark the shift in gear.
  if (intensity > 0.35 && bar % 2 === 1) {
    const src = ctx.createBufferSource();
    src.buffer = getNoise();
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 7000;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.06 + intensity * 0.05, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
    src.connect(hp);
    hp.connect(g);
    g.connect(musicBus);
    src.start(t);
    src.stop(t + 0.08);
  }
}

function scheduler() {
  if (!musicOn || !ready) return;
  const stepDur = 60 / (96 + intensity * 40) / 4; // 16ths, tempo rises with intensity
  while (nextNoteTime < ctx.currentTime + 0.25) {
    scheduleStep(nextNoteTime, step);
    nextNoteTime += stepDur;
    step++;
  }
  schedTimer = setTimeout(scheduler, 60);
}

export function startMusic() {
  musicWanted = true;
  if (!ready || musicOn || !settings.music) return;
  musicOn = true;
  step = 0;
  nextNoteTime = ctx.currentTime + 0.08;
  musicBus.gain.setTargetAtTime(settings.music ? musicTarget : 0, ctx.currentTime, 0.4);
  scheduler();
}

export function stopMusic(fade = 0.4, keepWanted = false) {
  if (!keepWanted) musicWanted = false;
  if (!ready) return;
  musicOn = false;
  clearTimeout(schedTimer);
  musicBus.gain.setTargetAtTime(0, ctx.currentTime, fade);
}

// 0..1 — drives tempo, arp density, filter brightness.
export function setIntensity(v) {
  intensity = Math.max(0, Math.min(1, v));
}

export function duckMusic(amount = 0.25, time = 0.6) {
  if (!ready || !musicOn) return;
  musicBus.gain.cancelScheduledValues(ctx.currentTime);
  musicBus.gain.setTargetAtTime(settings.music ? musicTarget * amount : 0, ctx.currentTime, 0.05);
  musicBus.gain.setTargetAtTime(settings.music ? musicTarget : 0, ctx.currentTime + time, 0.3);
}
