// Touch/pointer abstraction. Goals: zero perceptible latency, no browser
// gestures stealing input (scroll, pull-to-refresh, double-tap zoom, text
// selection), and a mouse fallback so the game is testable on a desktop.

export class Input {
  constructor(canvas) {
    this.canvas = canvas;
    this.pointers = new Map(); // id -> { x, y, sx, sy, t0, moved }
    this.primary = null;

    // Consumed once per frame by the game, then cleared.
    this.taps = [];
    this.swipes = [];
    this.presses = [];
    this.releases = [];
    // Cancels are kept separate from releases on purpose. A notification
    // banner or a palm touch fires pointercancel, and a game that treats that
    // as "the player lifted their thumb" will steal runs from people.
    this.cancels = [];
    this.lastCancelAt = -1e9;

    this.held = false;
    this.x = 0;
    this.y = 0;
    this.dx = 0;
    this.dy = 0;
    this.holdTime = 0;

    this._bind();
  }

  _pos(e) {
    const r = this.canvas.getBoundingClientRect();
    return {
      x: ((e.clientX - r.left) / r.width) * this.canvas.clientWidth,
      y: ((e.clientY - r.top) / r.height) * this.canvas.clientHeight,
    };
  }

  _bind() {
    const c = this.canvas;
    const opts = { passive: false };

    const down = (e) => {
      // Only swallow gestures that start on the play surface.
      if (e.cancelable) e.preventDefault();
      const p = this._pos(e);
      const rec = { x: p.x, y: p.y, sx: p.x, sy: p.y, px: p.x, py: p.y, t0: performance.now(), moved: 0 };
      this.pointers.set(e.pointerId, rec);
      if (this.primary === null) {
        this.primary = e.pointerId;
        this.held = true;
        this.holdTime = 0;
        this.x = p.x;
        this.y = p.y;
        this.dx = 0;
        this.dy = 0;
      }
      this.presses.push({ x: p.x, y: p.y, id: e.pointerId, count: this.pointers.size });
      try {
        c.setPointerCapture(e.pointerId);
      } catch {
        /* capture is best-effort; input still works without it */
      }
    };

    const move = (e) => {
      const rec = this.pointers.get(e.pointerId);
      if (!rec) return;
      if (e.cancelable) e.preventDefault();
      const p = this._pos(e);
      rec.px = rec.x;
      rec.py = rec.y;
      rec.x = p.x;
      rec.y = p.y;
      rec.moved += Math.hypot(rec.x - rec.px, rec.y - rec.py);
      if (e.pointerId === this.primary) {
        this.dx += rec.x - rec.px;
        this.dy += rec.y - rec.py;
        this.x = rec.x;
        this.y = rec.y;
      }
    };

    const up = (e, cancelled = false) => {
      const rec = this.pointers.get(e.pointerId);
      if (!rec) return;
      if (e.cancelable) e.preventDefault();
      const dt = performance.now() - rec.t0;
      const wasPrimary = e.pointerId === this.primary;

      if (cancelled) {
        this.lastCancelAt = performance.now();
        this.cancels.push({ x: rec.x, y: rec.y, id: e.pointerId, wasPrimary });
        this._drop(e.pointerId, c);
        return;
      }

      const dx = rec.x - rec.sx;
      const dy = rec.y - rec.sy;
      const dist = Math.hypot(dx, dy);

      // A flick: far enough, fast enough. Otherwise it reads as a tap.
      if (dist > 42 && dt < 320) {
        this.swipes.push({ dx, dy, dist, dt, x: rec.sx, y: rec.sy, ex: rec.x, ey: rec.y });
      } else if (dist < 20 && dt < 320) {
        this.taps.push({ x: rec.x, y: rec.y, id: e.pointerId });
      }
      this.releases.push({ x: rec.x, y: rec.y, id: e.pointerId, duration: dt, dist, wasPrimary });
      this._drop(e.pointerId, c);
    };

    c.addEventListener('pointerdown', down, opts);
    c.addEventListener('pointermove', move, opts);
    c.addEventListener('pointerup', (e) => up(e, false), opts);
    c.addEventListener('pointercancel', (e) => up(e, true), opts);
    c.addEventListener('lostpointercapture', (e) => up(e, true), opts);

    // Belt and braces against mobile browser chrome.
    c.addEventListener('touchstart', (e) => e.cancelable && e.preventDefault(), opts);
    c.addEventListener('touchmove', (e) => e.cancelable && e.preventDefault(), opts);
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    c.addEventListener('dblclick', (e) => e.preventDefault());

    // Keyboard is a developer/desktop convenience, not a documented control.
    this.keys = new Set();
    window.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      this.keys.add(e.key);
      if (e.key === ' ' || e.key.startsWith('Arrow')) e.preventDefault();
      if (e.key === ' ') {
        this.held = true;
        this.presses.push({ x: this.canvas.clientWidth / 2, y: this.canvas.clientHeight / 2, key: true, count: 1 });
      }
    });
    window.addEventListener('keyup', (e) => {
      this.keys.delete(e.key);
      if (e.key === ' ') {
        this.held = false;
        this.taps.push({ x: this.canvas.clientWidth / 2, y: this.canvas.clientHeight / 2, key: true });
        this.releases.push({ x: 0, y: 0, key: true, duration: 0, dist: 0 });
      }
    });

    // If the app is backgrounded mid-hold the pointerup never arrives.
    window.addEventListener('blur', () => this.clearAll());
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') this.clearAll();
    });
  }

  // Removes a pointer and promotes a replacement, so lifting the first finger
  // during a two-finger moment doesn't drop the hold.
  _drop(id, canvas) {
    this.pointers.delete(id);
    if (id === this.primary) {
      const nextId = this.pointers.keys().next();
      if (!nextId.done) {
        this.primary = nextId.value;
        const n = this.pointers.get(this.primary);
        this.x = n.x;
        this.y = n.y;
      } else {
        this.primary = null;
        this.held = false;
        this.holdTime = 0;
      }
    }
    try {
      canvas.releasePointerCapture(id);
    } catch {
      /* nothing to release */
    }
  }

  clearAll() {
    this.pointers.clear();
    this.primary = null;
    this.held = false;
    this.holdTime = 0;
    this.dx = 0;
    this.dy = 0;
  }

  // Call once per frame, after the game has read the event queues.
  endFrame(dt) {
    if (this.held) this.holdTime += dt;
    this.taps.length = 0;
    this.swipes.length = 0;
    this.presses.length = 0;
    this.releases.length = 0;
    this.cancels.length = 0;
    this.dx = 0;
    this.dy = 0;
  }

  // True when a pointercancel landed recently enough that a lift should not
  // be trusted as intentional.
  cancelledRecently(ms = 200) {
    return performance.now() - this.lastCancelAt < ms;
  }

  // Convenience: was there a tap inside this rect this frame?
  tapIn(x, y, w, h) {
    for (const t of this.taps) {
      if (t.x >= x && t.x <= x + w && t.y >= y && t.y <= y + h) return t;
    }
    return null;
  }
}

// Short haptic pulse where supported. Silently a no-op on iOS Safari.
let hapticsOn = true;
export function setHaptics(on) {
  hapticsOn = on;
}
export function buzz(ms = 12) {
  if (!hapticsOn) return;
  try {
    navigator.vibrate?.(ms);
  } catch {
    /* unsupported */
  }
}
