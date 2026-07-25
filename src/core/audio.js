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
  tap: () => tone({ freq: 660, freq2: 880, type: 'triangle', dur: 0.06, gain: 0.18 }),

  uiMove: () => tone({ freq: 520, type: 'square', dur: 0.045, gain: 0.12 }),

  uiConfirm: () => {
    tone({ freq: 523, type: 'triangle', dur: 0.09, gain: 0.2 });
    tone({ freq: 784, type: 'triangle', dur: 0.12, gain: 0.16, delay: 0.06 });
  },

  uiBack: () => tone({ freq: 400, freq2: 260, type: 'triangle', dur: 0.1, gain: 0.16 }),

  // Pitch climbs with the combo so a streak audibly ascends.
  shatter: (step = 0) => {
    const s = Math.min(step, 24);
    tone({ freq: 300 * SEMI(s), freq2: 600 * SEMI(s), type: 'square', dur: 0.09, gain: 0.22 });
    noise({ dur: 0.16, gain: 0.24, cutoff: 6000, cutoff2: 800, filter: 'bandpass', q: 0.8 });
  },

  perfect: (step = 0) => {
    const s = Math.min(step, 24);
    const base = 660 * SEMI(s);
    tone({ freq: base, type: 'triangle', dur: 0.1, gain: 0.2 });
    tone({ freq: base * 1.5, type: 'sine', dur: 0.18, gain: 0.16, delay: 0.03 });
    tone({ freq: base * 2, type: 'sine', dur: 0.22, gain: 0.1, delay: 0.06 });
  },

  dash: () => {
    noise({ dur: 0.22, gain: 0.22, cutoff: 400, cutoff2: 3400, filter: 'bandpass', q: 1.4 });
    tone({ freq: 180, freq2: 420, type: 'sawtooth', dur: 0.14, gain: 0.12 });
  },

  bounce: () => tone({ freq: 220, freq2: 340, type: 'sine', dur: 0.09, gain: 0.22 }),

  pickup: () => {
    tone({ freq: 880, type: 'sine', dur: 0.07, gain: 0.16 });
    tone({ freq: 1320, type: 'sine', dur: 0.1, gain: 0.12, delay: 0.05 });
  },

  shieldBreak: () => {
    noise({ dur: 0.3, gain: 0.3, cutoff: 4000, cutoff2: 300, filter: 'lowpass' });
    tone({ freq: 500, freq2: 120, type: 'sawtooth', dur: 0.26, gain: 0.2 });
  },

  hurt: () => {
    tone({ freq: 240, freq2: 70, type: 'sawtooth', dur: 0.3, gain: 0.3 });
    noise({ dur: 0.25, gain: 0.22, cutoff: 900, cutoff2: 160 });
  },

  death: () => {
    tone({ freq: 330, freq2: 55, type: 'sawtooth', dur: 0.9, gain: 0.3 });
    tone({ freq: 220, freq2: 40, type: 'square', dur: 1.1, gain: 0.18, delay: 0.05 });
    noise({ dur: 0.9, gain: 0.25, cutoff: 2200, cutoff2: 120 });
  },

  levelUp: () => {
    [0, 4, 7, 12].forEach((n, i) =>
      tone({ freq: 440 * SEMI(n), type: 'triangle', dur: 0.22, gain: 0.18, delay: i * 0.07 })
    );
  },

  unlock: () => {
    [0, 5, 9, 12, 16].forEach((n, i) =>
      tone({ freq: 392 * SEMI(n), type: 'sine', dur: 0.4, gain: 0.16, delay: i * 0.09 })
    );
  },

  warn: () => tone({ freq: 180, type: 'square', dur: 0.14, gain: 0.14 }),

  rush: () => {
    tone({ freq: 90, freq2: 300, type: 'sawtooth', dur: 0.5, gain: 0.22 });
    noise({ dur: 0.6, gain: 0.2, cutoff: 200, cutoff2: 5000, filter: 'bandpass', q: 1.2 });
  },
};

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
