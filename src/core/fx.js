// Game feel: particles, screenshake, floating text, full-screen flashes,
// shockwave rings. Everything is pooled — a run spawns tens of thousands of
// particles and per-frame allocation would hand the GC a stutter every second.

const TAU = Math.PI * 2;

class Pool {
  constructor(make, size) {
    this.items = new Array(size);
    for (let i = 0; i < size; i++) this.items[i] = make();
    this.count = 0; // live items occupy [0, count)
  }

  spawn() {
    if (this.count >= this.items.length) {
      // Full: recycle the oldest rather than growing without bound.
      const o = this.items[0];
      this.items.copyWithin(0, 1);
      this.items[this.count - 1] = o;
      return o;
    }
    return this.items[this.count++];
  }

  // Swap-remove keeps the live prefix dense without shifting the array.
  release(i) {
    this.count--;
    const t = this.items[i];
    this.items[i] = this.items[this.count];
    this.items[this.count] = t;
  }

  clear() {
    this.count = 0;
  }
}

export class Fx {
  constructor({ reduceMotion = false } = {}) {
    this.reduceMotion = reduceMotion;

    this.particles = new Pool(
      () => ({ x: 0, y: 0, vx: 0, vy: 0, life: 0, max: 1, size: 2, color: '#fff', drag: 0.98, gravity: 0, shape: 0, spin: 0, rot: 0, glow: 0 }),
      1400
    );
    this.texts = new Pool(
      () => ({ x: 0, y: 0, vy: 0, life: 0, max: 1, text: '', color: '#fff', size: 16, weight: 700 }),
      64
    );
    this.rings = new Pool(
      () => ({ x: 0, y: 0, r: 0, r2: 0, life: 0, max: 1, color: '#fff', width: 3 }),
      48
    );

    this.shakeAmp = 0;
    this.shakeDecay = 6;
    this.shakeX = 0;
    this.shakeY = 0;
    this.shakeSeed = Math.random() * 1000;

    this.flashColor = null;
    this.flashAlpha = 0;
    this.flashDecay = 4;

    this.chroma = 0; // 0..1, drives a cheap RGB-split vignette
  }

  clear() {
    this.particles.clear();
    this.texts.clear();
    this.rings.clear();
    this.shakeAmp = 0;
    this.flashAlpha = 0;
    this.chroma = 0;
  }

  // ------------------------------------------------------------- spawners

  shake(amp, decay = 6) {
    if (this.reduceMotion) amp *= 0.25;
    this.shakeAmp = Math.max(this.shakeAmp, amp);
    this.shakeDecay = decay;
  }

  flash(color, alpha = 0.5, decay = 4) {
    if (this.reduceMotion) alpha *= 0.4;
    this.flashColor = color;
    this.flashAlpha = Math.max(this.flashAlpha, alpha);
    this.flashDecay = decay;
  }

  ring(x, y, r, r2, color, life = 0.35, width = 3) {
    const o = this.rings.spawn();
    o.x = x; o.y = y; o.r = r; o.r2 = r2;
    o.color = color; o.life = life; o.max = life; o.width = width;
    return o;
  }

  text(x, y, text, color = '#fff', size = 18, life = 0.9, vy = -46) {
    const o = this.texts.spawn();
    o.x = x; o.y = y; o.text = text; o.color = color;
    o.size = size; o.life = life; o.max = life; o.vy = vy;
    return o;
  }

  particle(x, y, vx, vy, opts = {}) {
    const p = this.particles.spawn();
    p.x = x; p.y = y; p.vx = vx; p.vy = vy;
    p.life = opts.life ?? 0.6;
    p.max = p.life;
    p.size = opts.size ?? 3;
    p.color = opts.color ?? '#fff';
    p.drag = opts.drag ?? 0.94;
    p.gravity = opts.gravity ?? 0;
    p.shape = opts.shape ?? 0; // 0 circle, 1 square, 2 shard, 3 spark line
    p.spin = opts.spin ?? 0;
    p.rot = opts.rot ?? 0;
    p.glow = opts.glow ?? 0;
    return p;
  }

  // Radial burst — the default "something happened here" effect.
  burst(x, y, count, opts = {}) {
    const n = this.reduceMotion ? Math.ceil(count * 0.4) : count;
    const speed = opts.speed ?? 180;
    const spread = opts.spread ?? TAU;
    const dir = opts.dir ?? 0;
    for (let i = 0; i < n; i++) {
      const a = dir + (Math.random() - 0.5) * spread;
      const s = speed * (0.35 + Math.random() * 0.9);
      this.particle(x, y, Math.cos(a) * s, Math.sin(a) * s, {
        life: (opts.life ?? 0.55) * (0.6 + Math.random() * 0.8),
        size: (opts.size ?? 3) * (0.6 + Math.random() * 0.9),
        color: Array.isArray(opts.color) ? opts.color[(Math.random() * opts.color.length) | 0] : opts.color ?? '#fff',
        drag: opts.drag ?? 0.93,
        gravity: opts.gravity ?? 0,
        shape: opts.shape ?? 0,
        spin: (Math.random() - 0.5) * 12,
        rot: Math.random() * TAU,
        glow: opts.glow ?? 0,
      });
    }
  }

  // A directed cone — dashes, thruster trails, impact sprays.
  spray(x, y, dir, count, opts = {}) {
    this.burst(x, y, count, { ...opts, dir, spread: opts.spread ?? 0.9 });
  }

  // --------------------------------------------------------------- update

  update(dt) {
    const ps = this.particles;
    for (let i = ps.count - 1; i >= 0; i--) {
      const p = ps.items[i];
      p.life -= dt;
      if (p.life <= 0) {
        ps.release(i);
        continue;
      }
      p.vy += p.gravity * dt;
      const d = Math.pow(p.drag, dt * 60);
      p.vx *= d;
      p.vy *= d;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.rot += p.spin * dt;
    }

    const ts = this.texts;
    for (let i = ts.count - 1; i >= 0; i--) {
      const t = ts.items[i];
      t.life -= dt;
      if (t.life <= 0) {
        ts.release(i);
        continue;
      }
      t.y += t.vy * dt;
      t.vy *= Math.pow(0.9, dt * 60);
    }

    const rs = this.rings;
    for (let i = rs.count - 1; i >= 0; i--) {
      const r = rs.items[i];
      r.life -= dt;
      if (r.life <= 0) rs.release(i);
    }

    if (this.shakeAmp > 0.01) {
      this.shakeAmp *= Math.pow(0.001, dt * (this.shakeDecay / 6));
      this.shakeSeed += dt * 60;
      // Two out-of-phase sines read as a sharp rattle rather than a wobble.
      const s = this.shakeSeed;
      this.shakeX = (Math.sin(s * 1.7) + Math.sin(s * 3.1)) * 0.5 * this.shakeAmp;
      this.shakeY = (Math.cos(s * 2.3) + Math.cos(s * 4.7)) * 0.5 * this.shakeAmp;
    } else {
      this.shakeAmp = 0;
      this.shakeX = 0;
      this.shakeY = 0;
    }

    if (this.flashAlpha > 0.001) {
      this.flashAlpha *= Math.pow(0.001, dt * (this.flashDecay / 4));
    } else {
      this.flashAlpha = 0;
    }

    if (this.chroma > 0.001) this.chroma *= Math.pow(0.02, dt);
    else this.chroma = 0;
  }

  // --------------------------------------------------------------- render

  drawParticles(ctx) {
    const ps = this.particles;
    let lastGlow = 0;
    ctx.save();
    for (let i = 0; i < ps.count; i++) {
      const p = ps.items[i];
      const k = p.life / p.max;
      ctx.globalAlpha = k > 0.7 ? 1 : k / 0.7;
      ctx.fillStyle = p.color;

      // Batch shadow state changes — setting shadowBlur per particle is one of
      // the fastest ways to destroy Canvas 2D performance.
      if (p.glow !== lastGlow) {
        ctx.shadowBlur = p.glow;
        ctx.shadowColor = p.color;
        lastGlow = p.glow;
      } else if (p.glow) {
        ctx.shadowColor = p.color;
      }

      const s = p.size * (0.4 + k * 0.6);
      if (p.shape === 0) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, s, 0, TAU);
        ctx.fill();
      } else if (p.shape === 1) {
        ctx.fillRect(p.x - s, p.y - s, s * 2, s * 2);
      } else if (p.shape === 2) {
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.beginPath();
        ctx.moveTo(0, -s * 1.6);
        ctx.lineTo(s, 0);
        ctx.lineTo(0, s * 1.6);
        ctx.lineTo(-s, 0);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
      } else {
        // Velocity-aligned streak — reads as speed for very little cost.
        const m = Math.hypot(p.vx, p.vy) || 1;
        ctx.strokeStyle = p.color;
        ctx.lineWidth = s;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(p.x - (p.vx / m) * s * 4, p.y - (p.vy / m) * s * 4);
        ctx.stroke();
      }
    }
    ctx.shadowBlur = 0;
    ctx.globalAlpha = 1;
    ctx.restore();
  }

  drawRings(ctx) {
    const rs = this.rings;
    ctx.save();
    for (let i = 0; i < rs.count; i++) {
      const r = rs.items[i];
      const k = 1 - r.life / r.max; // 0 -> 1 as it expands
      const rad = r.r + (r.r2 - r.r) * (1 - Math.pow(1 - k, 3));
      ctx.globalAlpha = (1 - k) * 0.9;
      ctx.strokeStyle = r.color;
      ctx.lineWidth = r.width * (1 - k * 0.7);
      ctx.beginPath();
      ctx.arc(r.x, r.y, Math.max(0.5, rad), 0, TAU);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    ctx.restore();
  }

  drawTexts(ctx, font = 'system-ui, sans-serif') {
    const ts = this.texts;
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let i = 0; i < ts.count; i++) {
      const t = ts.items[i];
      const k = t.life / t.max;
      const pop = k > 0.85 ? 1 + (k - 0.85) * 3 : 1; // brief overshoot on spawn
      ctx.globalAlpha = k > 0.5 ? 1 : k / 0.5;
      ctx.font = `800 ${(t.size * pop).toFixed(1)}px ${font}`;
      ctx.lineWidth = 4;
      ctx.strokeStyle = 'rgba(6,6,18,0.85)';
      ctx.strokeText(t.text, t.x, t.y);
      ctx.fillStyle = t.color;
      ctx.fillText(t.text, t.x, t.y);
    }
    ctx.globalAlpha = 1;
    ctx.restore();
  }

  drawFlash(ctx, w, h) {
    if (this.flashAlpha <= 0.002 || !this.flashColor) return;
    ctx.save();
    ctx.globalAlpha = Math.min(1, this.flashAlpha);
    ctx.fillStyle = this.flashColor;
    ctx.fillRect(0, 0, w, h);
    ctx.restore();
  }
}
