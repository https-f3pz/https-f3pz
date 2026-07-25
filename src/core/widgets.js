// A tiny immediate-mode UI toolkit drawn straight onto the game canvas.
//
// Why not DOM? One surface means one coordinate system, no z-index fights, no
// 300ms tap quirks, and menus that can be shaken, tinted and particle-blasted
// by the same effects the game uses. The cost is that we implement buttons
// ourselves — which is about 80 lines.

import { roundRect, outlinedText, withAlpha, ease, clamp } from './draw.js';

// Touch targets below ~44px are a genuine accessibility failure on a phone.
export const MIN_TOUCH = 46;

export class UI {
  constructor() {
    this.press = new Map(); // key -> 0..1 press animation
    this.hot = null; // key currently held
    this.frameKeys = new Set();
  }

  begin() {
    this.frameKeys.clear();
  }

  // Decay press animations for anything not drawn this frame.
  end(dt) {
    for (const [k, v] of this.press) {
      if (!this.frameKeys.has(k)) {
        const nv = v - dt * 6;
        if (nv <= 0) this.press.delete(k);
        else this.press.set(k, nv);
      }
    }
  }

  _anim(key, down, dt) {
    this.frameKeys.add(key);
    const cur = this.press.get(key) ?? 0;
    const target = down ? 1 : 0;
    const next = cur + (target - cur) * clamp(dt * (down ? 22 : 10), 0, 1);
    this.press.set(key, next);
    return next;
  }

  /**
   * A button. Returns true on the frame it is released inside its bounds.
   * Hit area is inflated to MIN_TOUCH even when the art is smaller.
   */
  button(ctx, input, dt, key, x, y, w, h, label, opts = {}) {
    const {
      fill = '#1b1740',
      fillActive = '#2a2260',
      stroke = '#6df2ff',
      text = '#ffffff',
      textSize = 19,
      radius = 14,
      disabled = false,
      glow = 0,
      icon = null,
      sub = null,
      align = 'center',
    } = opts;

    const padX = Math.max(0, (MIN_TOUCH - w) / 2);
    const padY = Math.max(0, (MIN_TOUCH - h) / 2);
    const hx = x - padX;
    const hy = y - padY;
    const hw = w + padX * 2;
    const hh = h + padY * 2;

    const inside = (p) => p && p.x >= hx && p.x <= hx + hw && p.y >= hy && p.y <= hy + hh;

    let held = false;
    let clicked = false;
    if (!disabled) {
      for (const p of input.presses) if (inside(p)) this.hot = key;
      if (this.hot === key) {
        // Held as long as any active pointer is inside.
        for (const [, p] of input.pointers) if (inside(p)) held = true;
      }
      for (const r of input.releases) {
        if (this.hot === key && inside(r)) {
          clicked = true;
          this.hot = null;
        } else if (this.hot === key && input.pointers.size === 0) {
          this.hot = null;
        }
      }
      // Keyboard/synthetic taps that never produced a press record.
      for (const t of input.taps) if (inside(t) && !clicked) clicked = true;
    }

    const a = this._anim(key, held, dt);
    const scale = 1 - a * 0.045;
    const cx = x + w / 2;
    const cy = y + h / 2;

    ctx.save();
    ctx.globalAlpha = disabled ? 0.42 : 1;
    ctx.translate(cx, cy);
    ctx.scale(scale, scale);
    ctx.translate(-cx, -cy);

    if (glow > 0 && !disabled) {
      ctx.shadowColor = withAlpha(stroke, 0.8);
      ctx.shadowBlur = glow * (1 + a * 0.6);
    }
    roundRect(ctx, x, y, w, h, radius);
    ctx.fillStyle = a > 0.02 ? fillActive : fill;
    ctx.fill();
    ctx.shadowBlur = 0;

    ctx.lineWidth = 2;
    ctx.strokeStyle = withAlpha(stroke, 0.55 + a * 0.45);
    ctx.stroke();

    // A soft top highlight so the panel reads as a raised surface.
    ctx.save();
    ctx.clip();
    const g = ctx.createLinearGradient(0, y, 0, y + h);
    g.addColorStop(0, 'rgba(255,255,255,0.10)');
    g.addColorStop(0.5, 'rgba(255,255,255,0.02)');
    g.addColorStop(1, 'rgba(0,0,0,0.18)');
    ctx.fillStyle = g;
    ctx.fillRect(x, y, w, h);
    ctx.restore();

    const tx = align === 'left' ? x + 18 : cx;
    const ty = sub ? cy - textSize * 0.42 : cy;
    if (icon) icon(ctx, x, y, w, h);
    outlinedText(ctx, label, tx, ty, {
      size: textSize,
      color: text,
      align: align === 'left' ? 'left' : 'center',
      outlineWidth: 0,
      weight: 800,
    });
    if (sub) {
      outlinedText(ctx, sub, tx, cy + textSize * 0.62, {
        size: textSize * 0.62,
        color: withAlpha(text, 0.62),
        align: align === 'left' ? 'left' : 'center',
        outlineWidth: 0,
        weight: 600,
      });
    }
    ctx.restore();

    return clicked && !disabled;
  }

  toggle(ctx, input, dt, key, x, y, w, h, label, value, opts = {}) {
    const on = !!value;
    const clicked = this.button(ctx, input, dt, key, x, y, w, h, label, {
      ...opts,
      align: 'left',
      stroke: on ? opts.stroke ?? '#6df2ff' : '#4a4570',
      text: on ? '#ffffff' : '#9d99c4',
    });

    // Pill switch on the right edge.
    const pw = 46;
    const ph = 26;
    const px = x + w - pw - 16;
    const py = y + (h - ph) / 2;
    const t = ease.outCubic(clamp(this._trackToggle(key, on, dt), 0, 1));
    ctx.save();
    roundRect(ctx, px, py, pw, ph, ph / 2);
    ctx.fillStyle = on ? withAlpha(opts.stroke ?? '#6df2ff', 0.32) : 'rgba(255,255,255,0.08)';
    ctx.fill();
    ctx.strokeStyle = on ? withAlpha(opts.stroke ?? '#6df2ff', 0.8) : 'rgba(255,255,255,0.18)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    const kx = px + 3 + t * (pw - ph + 0);
    ctx.beginPath();
    ctx.arc(kx + (ph - 6) / 2, py + ph / 2, (ph - 6) / 2, 0, Math.PI * 2);
    ctx.fillStyle = on ? opts.stroke ?? '#6df2ff' : '#7d78a8';
    ctx.fill();
    ctx.restore();

    return clicked;
  }

  _toggleAnim = new Map();
  _trackToggle(key, on, dt) {
    const cur = this._toggleAnim.get(key) ?? (on ? 1 : 0);
    const next = cur + ((on ? 1 : 0) - cur) * clamp(dt * 14, 0, 1);
    this._toggleAnim.set(key, next);
    return next;
  }
}

// A framed panel with a title — the base of every menu and dialog.
export function panel(ctx, x, y, w, h, opts = {}) {
  const { fill = 'rgba(11,9,30,0.92)', stroke = 'rgba(140,120,255,0.35)', radius = 22, blurGlow = 0 } = opts;
  ctx.save();
  if (blurGlow) {
    ctx.shadowColor = 'rgba(120,90,255,0.55)';
    ctx.shadowBlur = blurGlow;
  }
  roundRect(ctx, x, y, w, h, radius);
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = stroke;
  ctx.stroke();
  ctx.restore();
}

// Horizontal progress/meter bar with an optional pulsing "danger" state.
export function meter(ctx, x, y, w, h, value, opts = {}) {
  const { bg = 'rgba(255,255,255,0.10)', fg = '#6df2ff', radius = h / 2, glow = 0, pulse = 0 } = opts;
  const v = clamp(value, 0, 1);
  roundRect(ctx, x, y, w, h, radius);
  ctx.fillStyle = bg;
  ctx.fill();
  if (v > 0.001) {
    ctx.save();
    roundRect(ctx, x, y, w, h, radius);
    ctx.clip();
    if (glow) {
      ctx.shadowColor = fg;
      ctx.shadowBlur = glow + pulse * 10;
    }
    ctx.fillStyle = fg;
    ctx.fillRect(x, y, w * v, h);
    ctx.restore();
  }
}

// Fits text into a maximum width by shrinking the font, never by truncating.
export function fitText(ctx, text, maxWidth, startSize, font = 'system-ui, sans-serif', weight = 800) {
  let size = startSize;
  ctx.font = `${weight} ${size}px ${font}`;
  while (ctx.measureText(text).width > maxWidth && size > 8) {
    size -= 1;
    ctx.font = `${weight} ${size}px ${font}`;
  }
  return size;
}
