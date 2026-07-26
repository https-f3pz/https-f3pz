// Fixed-timestep game loop with interpolation-free rendering (we render the
// simulated state directly; at 120Hz sim on a 60Hz screen the difference is
// invisible and the code stays far simpler).
//
// Also owns the two time-warping tools every action game needs: hitstop
// (freeze frames on impact) and slow motion (used for near-misses and the
// upgrade choice moment).

const STEP = 1 / 120; // seconds of simulated time per tick
const MAX_FRAME = 0.25; // never simulate more than 250ms after a stall

export class Loop {
  constructor({ update, render, onResize, beginFrame }) {
    this.update = update;
    this.render = render;
    this.onResize = onResize;
    // Runs exactly once per rendered frame, before any simulation substep.
    // Discrete input has to be latched here: a frame can run zero substeps
    // (during slow-mo, hitstop, or on a high-refresh display), and anything
    // consumed inside the substep loop would then be dropped or replayed.
    this.beginFrame = beginFrame;
    this.acc = 0;
    this.last = 0;
    this.raf = 0;
    this.running = false;
    this.hitstop = 0; // real seconds of frozen simulation remaining
    this.timeScale = 1; // slow-mo multiplier
    this.targetScale = 1;
    this.elapsed = 0; // total scaled sim time
    this.frame = 0;
    this.fps = 60;
    this.lastReal = 0;
    this._fpsAcc = 0;
    this._fpsFrames = 0;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.last = performance.now();
    this.raf = requestAnimationFrame(this._tick);
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this.raf);
  }

  freeze(seconds) {
    // Impacts overlap; take the longest rather than summing, or a busy frame
    // stacks into a visible lockup.
    this.hitstop = Math.max(this.hitstop, seconds);
  }

  slowmo(scale, _seconds) {
    this.targetScale = scale;
  }

  clearSlowmo() {
    this.targetScale = 1;
  }

  _tick = (now) => {
    if (!this.running) return;
    this.raf = requestAnimationFrame(this._tick);

    let real = (now - this.last) / 1000;
    this.last = now;
    if (real > MAX_FRAME) real = MAX_FRAME; // tab was backgrounded; don't fast-forward
    if (real < 0) real = 0;

    this._fpsAcc += real;
    this._fpsFrames++;
    if (this._fpsAcc >= 0.5) {
      this.fps = this._fpsFrames / this._fpsAcc;
      this._fpsAcc = 0;
      this._fpsFrames = 0;
    }

    // Ease toward the slow-mo target so entering/leaving it isn't a jolt.
    this.timeScale += (this.targetScale - this.timeScale) * Math.min(1, real * 12);

    // Real elapsed seconds, before hitstop and slow-motion touch it. An idle
    // economy must advance on this and not on scaled sim time, or a screen
    // shake would quietly cost the player production.
    this.lastReal = real;

    let simTime = real;
    if (this.hitstop > 0) {
      const eaten = Math.min(this.hitstop, real);
      this.hitstop -= eaten;
      simTime -= eaten;
    }

    this.acc += simTime * this.timeScale;

    if (this.beginFrame) this.beginFrame(real);

    // Cap catch-up work so a slow device degrades to slow-motion rather than
    // entering a death spiral of ever-longer frames.
    let steps = 0;
    while (this.acc >= STEP && steps < 8) {
      this.update(STEP);
      this.acc -= STEP;
      this.elapsed += STEP;
      steps++;
    }
    if (steps >= 8) this.acc = 0;

    this.frame++;
    this.render(real);
  };
}

export const FIXED_STEP = STEP;

// Canvas sizing that respects device pixel ratio without melting a phone GPU:
// we cap the backing store so a 3x 1440p screen doesn't ask Canvas 2D to fill
// 12 million pixels a frame.
export function fitCanvas(canvas, ctx, maxDpr = 2) {
  const cssW = canvas.clientWidth || window.innerWidth;
  const cssH = canvas.clientHeight || window.innerHeight;
  const dpr = Math.min(window.devicePixelRatio || 1, maxDpr);
  const w = Math.round(cssW * dpr);
  const h = Math.round(cssH * dpr);
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { w: cssW, h: cssH, dpr };
}
