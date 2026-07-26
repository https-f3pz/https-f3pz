// A scrolling viewport for immediate-mode lists.
//
// The subtle part is not the maths, it is the interaction with buttons. A
// finger that drags a list of buy buttons must not buy anything, and a finger
// that taps one must. The rule that makes both true:
//
//   * Buttons fire on RELEASE (widgets.js), never on press.
//   * A press inside the viewport is deliberately NOT marked used, so the
//     button underneath still latches and lights up.
//   * Once the finger has travelled more than THRESHOLD virtual pixels the
//     scroller CLAIMS the gesture and starts consuming releases, so the button
//     under the finger never fires.
//
// A tap under the threshold therefore behaves exactly as it did before this
// file existed, and a drag can never spend the player's money.

import { clamp, damp } from './draw.js';

/** Virtual pixels of travel before a touch becomes a scroll rather than a tap. */
const THRESHOLD = 12;
/** How far past the ends the list may be dragged before it springs back. */
const RUBBER = 80;

export class Scroller {
  constructor() {
    this.offset = 0;
    this.vel = 0;
    this.anchorY = 0;
    this.anchorOffset = 0;
    this.active = false;
    this.claimed = false;
    this.lastY = 0;
    this.recent = [];
    this.max = 0;
    this._saved = false;
  }

  /**
   * Open the viewport. Returns the current scroll offset; draw rows at
   * `y - offset` and skip any that fall outside [y, y + h].
   */
  begin(ctx, input, dt, x, y, w, h, contentH) {
    this.max = Math.max(0, contentH - h);
    const inside = (p) => p && p.x >= x && p.x <= x + w && p.y >= y && p.y <= y + h;

    for (const p of input.presses) {
      // Deliberately NOT marking the press used — the button under the finger
      // must still latch, or dragging would leave the list looking dead.
      if (inside(p)) {
        this.active = true;
        this.claimed = false;
        this.anchorY = p.y;
        this.lastY = p.y;
        this.anchorOffset = this.offset;
        this.vel = 0;
        this.recent.length = 0;
      }
    }

    if (this.active) {
      let live = null;
      for (const [, p] of input.pointers) live = p;
      if (live) {
        const dy = live.y - this.anchorY;
        if (!this.claimed && Math.abs(dy) > THRESHOLD) this.claimed = true;
        if (this.claimed) {
          let next = this.anchorOffset - dy;
          // Rubber band: resist past the ends rather than stopping dead.
          if (next < 0) next = next * 0.4;
          else if (next > this.max) next = this.max + (next - this.max) * 0.4;
          this.offset = next;
          this.recent.push({ dy: live.y - this.lastY, dt: Math.max(1e-3, dt) });
          if (this.recent.length > 3) this.recent.shift();
        }
        this.lastY = live.y;
      }
    }

    for (const r of input.releases) {
      if (!this.active) continue;
      if (this.claimed) {
        // Swallow the release so the button under the finger cannot fire.
        if (inside(r)) r.used = true;
        let sum = 0;
        let time = 0;
        for (const s of this.recent) { sum += s.dy; time += s.dt; }
        this.vel = time > 0 ? -sum / time : 0;
      }
      this.active = false;
      this.claimed = false;
      this.recent.length = 0;
    }

    // Momentum and spring-back, both frame-rate independent.
    if (!this.active) {
      if (this.offset < 0) {
        this.offset = damp(this.offset, 0, 12, dt);
        this.vel = 0;
      } else if (this.offset > this.max) {
        this.offset = damp(this.offset, this.max, 12, dt);
        this.vel = 0;
      } else if (Math.abs(this.vel) > 1) {
        this.offset += this.vel * dt;
        this.vel *= Math.pow(0.92, dt * 60);
        this.offset = clamp(this.offset, -RUBBER, this.max + RUBBER);
      } else {
        this.vel = 0;
      }
    }

    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.clip();
    this._saved = true;
    return this.offset;
  }

  end(ctx) {
    if (!this._saved) return;
    ctx.restore();
    this._saved = false;
  }

  /** True while a gesture has been claimed as a scroll, for tick sounds etc. */
  get scrolling() {
    return this.claimed || Math.abs(this.vel) > 1;
  }

  reset() {
    this.offset = 0;
    this.vel = 0;
    this.active = false;
    this.claimed = false;
  }
}
