// Application bootstrap: owns the canvas, the loop, and the lifecycle glue
// between the browser and the game. The Game itself knows nothing about
// resizing, safe areas, audio unlocking or backgrounding.

import { Loop, fitCanvas } from './core/loop.js';
import { Input, setHaptics } from './core/input.js';
import { Fx } from './core/fx.js';
import * as audio from './core/audio.js';
import { load, flushNow } from './core/storage.js';
import { clearGradientCache } from './core/draw.js';
import { Game } from './game/game.js';

const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });

// Text is the only thing we ever want the browser to smooth for us.
ctx.imageSmoothingEnabled = true;

const view = { w: 0, h: 0, dpr: 1, safe: { top: 0, right: 0, bottom: 0, left: 0 } };

function readSafeArea() {
  const probe = document.getElementById('safe-probe');
  if (!probe) return;
  const cs = getComputedStyle(probe);
  const px = (v) => parseFloat(v) || 0;
  view.safe.top = px(cs.paddingTop);
  view.safe.bottom = px(cs.paddingBottom);
  view.safe.left = px(cs.paddingLeft);
  view.safe.right = px(cs.paddingRight);
}

function resize() {
  const { w, h, dpr } = fitCanvas(canvas, ctx);
  view.w = w;
  view.h = h;
  view.dpr = dpr;
  readSafeArea();
  // Cached gradients are built in view-space coordinates.
  clearGradientCache();
  ctx.imageSmoothingEnabled = true;
  game?.onResize(view);
}

const save = load();
setHaptics(save.settings.haptics !== false);

const input = new Input(canvas);
const fx = new Fx({ reduceMotion: !!save.settings.reduceFx });

let game = null;
const loop = new Loop({
  // Latch and act on discrete input exactly once per rendered frame.
  beginFrame: () => game.beginFrame(),
  update: (dt) => game.update(dt, input),
  render: (realDt) => {
    game.render(ctx, view, realDt);
    input.endFrame(realDt);
  },
});

game = new Game({ ctx, view, input, fx, loop, audio });

// The first touch anywhere is what legally lets us make noise.
const unlockAudio = () => {
  audio.unlock();
  audio.configure({ sound: save.settings.sound !== false, music: save.settings.music !== false });
};
window.addEventListener('pointerdown', unlockAudio, { once: true });
window.addEventListener('keydown', unlockAudio, { once: true });

resize();
window.addEventListener('resize', resize);
window.addEventListener('orientationchange', () => setTimeout(resize, 120));
// iOS changes the visual viewport when the URL bar collapses without firing a
// window resize; visualViewport catches that.
window.visualViewport?.addEventListener('resize', resize);

// Backgrounding: freeze everything and stop making sound, then pick back up.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    game.onBlur();
    audio.suspend();
    flushNow();
  } else {
    audio.resume();
    // Rebase the clock so the loop doesn't try to simulate the time away.
    loop.last = performance.now();
  }
});
window.addEventListener('blur', () => game.onBlur());

game.init();
loop.start();

// Drop the splash once we know a real frame has painted.
requestAnimationFrame(() =>
  requestAnimationFrame(() => {
    const boot = document.getElementById('boot');
    if (!boot) return;
    boot.classList.add('gone');
    setTimeout(() => boot.remove(), 400);
  })
);

// A new service worker version is waiting: adopt it at the next quiet moment
// rather than yanking the page out from under a live run.
//
// `hadController` matters: on a first-ever visit the worker installs, calls
// clients.claim(), and fires controllerchange immediately. Without this guard
// that reloads the page underneath a first-time player for no reason.
const hadController = !!navigator.serviceWorker?.controller;
navigator.serviceWorker?.addEventListener?.('controllerchange', () => {
  if (hadController && game.state === 'menu') location.reload();
});

// Debug/automation surface. The play-test harness drives the game through
// this; it is deliberately tiny and read-mostly.
window.__GAME__ = {
  get state() {
    return game.state;
  },
  game,
  loop,
  fx,
  input,
  audio,
  debugSnapshot: () => game.snapshot(),
  debugKill: () => game.debugKill(),
  debugStart: (seed) => game.startRun(seed),
};
