// Canvas 2D drawing helpers. Kept allocation-free on the hot paths: gradients
// and paths are the two easiest ways to accidentally allocate 60 times a
// second, so anything reusable is cached by key.

const TAU = Math.PI * 2;

export function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.arcTo(x + w, y, x + w, y + rr, rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.arcTo(x + w, y + h, x + w - rr, y + h, rr);
  ctx.lineTo(x + rr, y + h);
  ctx.arcTo(x, y + h, x, y + h - rr, rr);
  ctx.lineTo(x, y + rr);
  ctx.arcTo(x, y, x + rr, y, rr);
  ctx.closePath();
}

export function polygon(ctx, x, y, radius, sides, rotation = 0) {
  ctx.beginPath();
  for (let i = 0; i < sides; i++) {
    const a = rotation + (i / sides) * TAU;
    const px = x + Math.cos(a) * radius;
    const py = y + Math.sin(a) * radius;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
}

export function star(ctx, x, y, outer, inner, points = 5, rotation = -Math.PI / 2) {
  ctx.beginPath();
  for (let i = 0; i < points * 2; i++) {
    const r = i % 2 === 0 ? outer : inner;
    const a = rotation + (i / (points * 2)) * TAU;
    const px = x + Math.cos(a) * r;
    const py = y + Math.sin(a) * r;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
}

// A crystal/diamond silhouette: wide shoulders, long point. Used for the
// player vessel and the falling shards.
export function crystal(ctx, x, y, w, h, rotation = 0) {
  ctx.save();
  ctx.translate(x, y);
  if (rotation) ctx.rotate(rotation);
  ctx.beginPath();
  ctx.moveTo(0, -h);
  ctx.lineTo(w, -h * 0.15);
  ctx.lineTo(w * 0.55, h);
  ctx.lineTo(-w * 0.55, h);
  ctx.lineTo(-w, -h * 0.15);
  ctx.closePath();
  ctx.restore();
}

// Gradients are expensive to build; cache by a cheap string key. The cache is
// bounded because callers key on quantized values.
const gradCache = new Map();

export function cachedLinearGradient(ctx, key, x0, y0, x1, y1, stops) {
  let g = gradCache.get(key);
  if (!g) {
    g = ctx.createLinearGradient(x0, y0, x1, y1);
    for (const [pos, color] of stops) g.addColorStop(pos, color);
    if (gradCache.size > 64) gradCache.clear();
    gradCache.set(key, g);
  }
  return g;
}

export function cachedRadialGradient(ctx, key, x, y, r0, r1, stops) {
  let g = gradCache.get(key);
  if (!g) {
    g = ctx.createRadialGradient(x, y, r0, x, y, r1);
    for (const [pos, color] of stops) g.addColorStop(pos, color);
    if (gradCache.size > 64) gradCache.clear();
    gradCache.set(key, g);
  }
  return g;
}

export function clearGradientCache() {
  gradCache.clear();
}

// #rrggbb + alpha -> rgba(). Avoids shipping a colour library for one job.
const rgbCache = new Map();
export function withAlpha(hex, alpha) {
  let rgb = rgbCache.get(hex);
  if (!rgb) {
    const h = hex.replace('#', '');
    const full = h.length === 3 ? h[0] + h[0] + h[1] + h[1] + h[2] + h[2] : h;
    rgb = [parseInt(full.slice(0, 2), 16), parseInt(full.slice(2, 4), 16), parseInt(full.slice(4, 6), 16)];
    rgbCache.set(hex, rgb);
  }
  return `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${alpha})`;
}

/**
 * Rotate a hex colour's hue, keeping saturation and lightness. Lets one small
 * hand-tuned palette set become an endless supply of them: rotating by a value
 * coprime with 360 means the cycle takes hundreds of repetitions to land back
 * on a colour the player has already seen.
 */
export function shiftHue(hex, deg) {
  if (!deg) return hex;
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h[0] + h[0] + h[1] + h[1] + h[2] + h[2] : h;
  let r = parseInt(full.slice(0, 2), 16) / 255;
  let g = parseInt(full.slice(2, 4), 16) / 255;
  let b = parseInt(full.slice(4, 6), 16) / 255;
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  const l = (mx + mn) / 2;
  let hh = 0;
  let s = 0;
  if (mx !== mn) {
    const d = mx - mn;
    s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
    if (mx === r) hh = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (mx === g) hh = ((b - r) / d + 2) / 6;
    else hh = ((r - g) / d + 4) / 6;
  }
  hh = (((hh + deg / 360) % 1) + 1) % 1;
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const chan = (t) => {
    let x = ((t % 1) + 1) % 1;
    if (x < 1 / 6) return p + (q - p) * 6 * x;
    if (x < 1 / 2) return q;
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
    return p;
  };
  const hx = (v) => Math.round(Math.min(255, Math.max(0, v * 255))).toString(16).padStart(2, '0');
  return `#${hx(chan(hh + 1 / 3))}${hx(chan(hh))}${hx(chan(hh - 1 / 3))}`;
}

export function mixHex(a, b, t) {
  const ha = a.replace('#', '');
  const hb = b.replace('#', '');
  const p = (h, i) => parseInt(h.slice(i * 2, i * 2 + 2), 16);
  const c = (i) => Math.round(p(ha, i) + (p(hb, i) - p(ha, i)) * t);
  const hx = (v) => v.toString(16).padStart(2, '0');
  return `#${hx(c(0))}${hx(c(1))}${hx(c(2))}`;
}

// Text with a dark outline so the HUD stays readable over any background,
// including a screen full of bright particles.
export function outlinedText(ctx, text, x, y, {
  size = 18,
  weight = 800,
  color = '#fff',
  outline = 'rgba(4,4,14,0.9)',
  outlineWidth = 4,
  align = 'center',
  baseline = 'middle',
  font = 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif',
} = {}) {
  ctx.save();
  ctx.font = `${weight} ${size}px ${font}`;
  ctx.textAlign = align;
  ctx.textBaseline = baseline;
  if (outlineWidth > 0) {
    ctx.lineWidth = outlineWidth;
    ctx.lineJoin = 'round';
    ctx.strokeStyle = outline;
    ctx.strokeText(text, x, y);
  }
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
  ctx.restore();
}

// Easing — used everywhere for menu transitions and pop animations.
export const ease = {
  outCubic: (t) => 1 - Math.pow(1 - t, 3),
  outQuint: (t) => 1 - Math.pow(1 - t, 5),
  inCubic: (t) => t * t * t,
  outBack: (t) => 1 + 2.70158 * Math.pow(t - 1, 3) + 1.70158 * Math.pow(t - 1, 2),
  outElastic: (t) => (t === 0 || t === 1 ? t : Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * ((2 * Math.PI) / 3)) + 1),
  inOutQuad: (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2),
  outBounce: (t) => {
    const n1 = 7.5625, d1 = 2.75;
    if (t < 1 / d1) return n1 * t * t;
    if (t < 2 / d1) return n1 * (t -= 1.5 / d1) * t + 0.75;
    if (t < 2.5 / d1) return n1 * (t -= 2.25 / d1) * t + 0.9375;
    return n1 * (t -= 2.625 / d1) * t + 0.984375;
  },
};

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
// Frame-rate independent exponential approach.
export const damp = (a, b, lambda, dt) => lerp(a, b, 1 - Math.exp(-lambda * dt));
export const TAU_ = TAU;
