// HOOKFALL — top-level state machine.
//
// Owns the virtual-space transform, the screen stack, the dive lifecycle, and
// the translation of simulation events into sound and particles. The Run knows
// nothing about screens; the screens know nothing about the simulation.

import { VW, VH_MIN, VH_MAX, PX_PER_M, PHYS } from './config.js';
import { Run } from './run.js';
import { Renderer, clearRockCache } from './render.js';
import { drawHud } from './hud.js';
import { drawTitle, drawHook, drawSettings, drawResults, drawPause } from './screens.js';
import { UI } from '../core/widgets.js';
import { makeRng, hashSeed, randomSeedWord } from '../core/rng.js';
import { load, save as writeSave, reset as resetSave } from '../core/storage.js';
import { recordRun, coachingLine, dailySeed, todayKey, buyUpgrade } from './meta.js';
import { setHaptics, buzz } from '../core/input.js';
import { clamp, lerp } from '../core/draw.js';
import * as audio from '../core/audio.js';

const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

export class Game {
  constructor({ ctx, view, input, fx, loop }) {
    this.ctx = ctx;
    this.rawView = view;
    this.rawInput = input;
    this.fx = fx;
    this.loop = loop;

    this.save = load();
    this.ui = new UI();
    this.renderer = new Renderer();

    this.screen = 'title'; // title | hook | settings | play | results | pause
    this.t = 0;
    this.run = null;
    this.result = null;
    this.countUp = 0;
    this.coach = '';
    this.confirmReset = false;
    this.isDaily = false;
    this.recorded = false;

    this.view = { vw: VW, vh: 1300, scale: 1, ox: 0, oy: 0, insetTop: 0, insetBottom: 0 };
    this.input = { taps: [], presses: [], releases: [], cancels: [], pointers: new Map(), primary: null };
    this.opt = { reduceGlow: false, quality: 1 };
    this.slowFrames = 0;
    this.fastFrames = 0;
  }

  init() {
    this.onResize(this.rawView);
    this.applySettings();
  }

  // --------------------------------------------------------------- layout

  onResize(view) {
    if (!view) return;
    this.rawView = view;
    const vh = clamp(VW * (view.h / Math.max(1, view.w)), VH_MIN, VH_MAX);
    const scale = Math.min(view.w / VW, view.h / vh);
    this.view.vh = vh;
    this.view.scale = scale;
    this.view.ox = (view.w - VW * scale) / 2;
    this.view.oy = (view.h - vh * scale) / 2;
    this.view.insetTop = view.safe.top / scale;
    this.view.insetBottom = view.safe.bottom / scale;
    clearRockCache();
    if (this.run) this.run.layout(this.view);
  }

  toVirtual(p) {
    return { x: (p.x - this.view.ox) / this.view.scale, y: (p.y - this.view.oy) / this.view.scale };
  }

  syncInput() {
    const li = this.input;
    li.taps.length = 0;
    li.presses.length = 0;
    li.releases.length = 0;
    li.cancels.length = 0;
    li.pointers.clear();
    const conv = (e) => {
      const v = this.toVirtual(e);
      const out = { ...e, x: v.x, y: v.y };
      // Start position matters: the reel gesture is measured from where the
      // thumb first landed, not from the screen.
      if (e.sx != null) {
        const s = this.toVirtual({ x: e.sx, y: e.sy });
        out.sx = s.x;
        out.sy = s.y;
      }
      return out;
    };
    for (const e of this.rawInput.taps) li.taps.push(conv(e));
    for (const e of this.rawInput.presses) li.presses.push(conv(e));
    for (const e of this.rawInput.releases) li.releases.push(conv(e));
    for (const e of this.rawInput.cancels) li.cancels.push(conv(e));
    for (const [id, p] of this.rawInput.pointers) li.pointers.set(id, conv(p));
    li.primary = this.rawInput.primary;
  }

  // ------------------------------------------------------------- settings

  applySettings() {
    const s = this.save.settings;
    setHaptics(!!s.haptics);
    audio.configure({ sound: !!s.sound, music: !!s.music });
    this.fx.reduceMotion = !!s.reduceGlow;
    this.fx.shakeScale = s.reduceShake ?? 1;
    this.opt = { reduceGlow: !!s.reduceGlow, quality: this.opt?.quality ?? 1 };
    writeSave({ settings: s });
  }

  persist(patch) {
    writeSave(patch);
  }

  buy(id) {
    return buyUpgrade(this.save, id);
  }

  wipeSave() {
    this.save = resetSave();
    this.confirmReset = false;
    this.applySettings();
    this.sfxBack();
  }

  sfxConfirm() {
    audio.sfx.uiConfirm();
  }

  sfxBack() {
    audio.sfx.uiBack();
  }

  // ------------------------------------------------------------ lifecycle

  beginRun({ daily = false } = {}) {
    // Replaying a banked daily is practice, not a second scored attempt.
    if (daily && this.save.daily?.date === todayKey() && this.save.daily?.locked) daily = false;
    this.isDaily = daily;
    this.recorded = false;
    this.confirmReset = false;

    const seed = daily ? dailySeed() : hashSeed(randomSeedWord() + Date.now());
    this.run = new Run({ seed, save: this.save, loop: this.loop, view: this.view, daily });
    this.run.tip = '';
    this.run.tipT = 0;
    this.run.banner = '';
    this.run.bannerT = 0;
    this.run.topSpeed = 0;
    this.run.hooks = 0;
    this.run.hookTime = 0;
    this.run.grazeCount = 0;

    this.fx.clear();
    this.loop.clearSlowmo();
    this.loop.hitstop = 0;
    this.screen = 'play';
    audio.unlock();
    audio.startMusic();
    this.maybeTip('PRESS AND HOLD TO HOOK', 3.4);
  }

  endRunEarly() {
    this.finishRun();
    this.screen = 'title';
    audio.stopMusic();
    audio.stopWhoosh();
  }

  finishRun() {
    if (!this.run || this.recorded) return;
    this.recorded = true;
    this.result = recordRun(this.save, this.run, { isDaily: this.isDaily });
    this.coach = coachingLine(this.run);
  }

  debugKill() {
    if (this.run && this.screen === 'play') this.run.killNow();
  }

  startRun() {
    this.beginRun({ daily: false });
  }

  snapshot() {
    const r = this.run;
    return {
      state: this.state,
      screen: this.screen,
      runTime: r ? r.time : 0,
      depth: r ? Math.round(r.depth) : 0,
      score: r ? Math.round(r.score) : 0,
      speed: r ? Math.round(Math.hypot(r.vx, r.vy)) : 0,
      combo: r ? r.combo : 0,
      hook: r ? r.hook : 0,
      anchors: r ? [...r.world.live()].reduce((n, c) => n + c.anchors.length, 0) : 0,
      hazards: r ? [...r.world.live()].reduce((n, c) => n + c.hazards.length, 0) : 0,
      fps: Math.round(this.loop.fps),
    };
  }

  get state() {
    if (this.screen === 'play') return this.run && this.run.dead ? 'over' : 'play';
    if (this.screen === 'results') return 'over';
    return this.screen === 'play' ? 'play' : this.screen === 'pause' ? 'pause' : 'menu';
  }

  onBlur() {
    if (this.screen === 'play' && this.run && !this.run.dead) this.pause();
  }

  pause() {
    if (this.screen !== 'play') return;
    this.screen = 'pause';
    audio.stopMusic(0.15);
    audio.stopWhoosh();
  }

  resume() {
    if (this.screen !== 'pause') return;
    this.screen = 'play';
    this.loop.last = performance.now();
    audio.startMusic();
  }

  maybeTip(text, dur) {
    if (this.save.seenTips[text]) return;
    this.save.seenTips[text] = true;
    writeSave({ seenTips: this.save.seenTips });
    if (this.run) {
      this.run.tip = text;
      this.run.tipT = dur;
    }
  }

  banner(text, dur = 1.5) {
    if (!this.run) return;
    this.run.banner = text;
    this.run.bannerT = dur;
  }

  // ------------------------------------------------- per-frame input latch

  beginFrame() {
    this.syncInput();
    if (this.screen !== 'play' || !this.run || this.run.dead) return;
    const run = this.run;

    // Pause sits in the top-left corner, clear of the play surface. Checked
    // first so it can swallow the press before it becomes a hook.
    const pb = { x: 0, y: this.view.insetTop + 70, w: 110, h: 110 };
    let swallowed = null;
    for (const p of this.input.presses) {
      if (p.x >= pb.x && p.x <= pb.x + pb.w && p.y >= pb.y && p.y <= pb.y + pb.h) {
        swallowed = p.id;
        this.pause();
        return;
      }
    }

    for (const p of this.input.presses) {
      if (p.id === swallowed) continue;
      run.selectTarget(p.x);
      run.fire(p.x);
      run.hooks++;
    }
    for (const r of this.input.releases) {
      if (!r.wasPrimary) continue;
      if (this.rawInput.cancelledRecently(200)) continue;
      run.release();
    }
    // A cancel is not a release: a notification banner must not detach a rope
    // mid-swing and drop the player into a saw.
    for (const c of this.input.cancels) {
      if (c.wasPrimary) run.release();
    }
  }

  // --------------------------------------------------------------- update

  update(dt) {
    this.t += dt;
    this.renderer.t = this.t;
    this.watchQuality();

    if (this.screen === 'play') this.updatePlay(dt);
    else if (this.screen === 'results') {
      const target = this.run ? this.run.depth : 0;
      if (this.countUp < target) {
        this.countUp = Math.min(target, this.countUp + Math.max(target / 0.9, 200) * dt);
      }
    }

    this.fx.update(dt);
  }

  // Adaptive quality with hysteresis. A phone that cannot hold the frame
  // should lose a parallax layer, not lose the game.
  watchQuality() {
    const fps = this.loop.fps;
    if (fps < 52) {
      this.slowFrames++;
      this.fastFrames = 0;
    } else if (fps > 58) {
      this.fastFrames++;
      this.slowFrames = 0;
    }
    if (this.slowFrames > 45 && this.opt.quality === 1) {
      this.opt.quality = 0;
      this.slowFrames = 0;
    } else if (this.fastFrames > 240 && this.opt.quality === 0) {
      this.opt.quality = 1;
      this.fastFrames = 0;
    }
  }

  updatePlay(dt) {
    const run = this.run;
    if (!run) return;

    if (run.dead) {
      run.update(dt, null);
      this.handleEvents();
      const since = performance.now() - (this.deathAt ?? performance.now());
      if (since > 500) this.loop.clearSlowmo();
      else this.loop.slowmo(0.25);
      if (since > 1300 && this.screen === 'play') {
        this.finishRun();
        this.countUp = 0;
        this.screen = 'results';
        this.loop.clearSlowmo();
      }
      return;
    }

    const steerId = this.input.primary;
    const p = steerId != null ? this.input.pointers.get(steerId) : null;
    const touch = p ? { x: p.x, y: p.y, startY: p.sy } : null;

    run.update(dt, touch);
    if (run.hook === 2) run.hookTime += dt;
    const sp = Math.hypot(run.vx, run.vy);
    if (sp > run.topSpeed) run.topSpeed = sp;

    run.selectTarget(p ? p.x : null);
    run.updateTrail(dt);
    this.handleEvents();

    if (run.tipT > 0) run.tipT -= dt;
    if (run.bannerT > 0) run.bannerT -= dt;
    if (run.whipT > 0) run.whipT -= dt;

    audio.setWhoosh(run.hook === 2 ? sp : sp * 0.35);
    audio.setIntensity(clamp(run.depth / 6000, 0, 1));

    if (run.hook === 2 && run.ropeAge > 1.2) this.maybeTip('SLIDE UP TO REEL IN AND PUMP SPEED', 3.0);
    if (run.combo >= 5) this.maybeTip('NEAR MISSES BUILD THE CHAIN', 2.6);
  }

  // Simulation events become sound, particles and shake here, so the Run never
  // has to know they exist.
  handleEvents() {
    const run = this.run;
    const fx = this.fx;
    const pal = this.renderer.palette(run.depth);

    for (const ev of run.events) {
      switch (ev.type) {
        case 'fire':
          audio.sfx.hookFire();
          break;

        case 'whiff':
          audio.sfx.whiff();
          break;

        case 'attach': {
          audio.sfx.attach();
          fx.ring(ev.a, ev.b, 6, 74, pal.accent, 0.3, 5);
          fx.shake(5, 7);
          break;
        }

        case 'release':
          audio.sfx.release();
          break;

        case 'whip': {
          audio.sfx.whipcrack();
          fx.shake(16, 4);
          fx.ring(ev.a, ev.b, 10, 190, '#FFFFFF', 0.35, 6);
          fx.burst(ev.a, ev.b, 26, {
            color: ['#FFFFFF', pal.accent], speed: 620, size: 4, life: 0.5, shape: 3, drag: 0.9,
          });
          this.banner('WHIPCRACK', 0.75);
          break;
        }

        case 'graze': {
          run.grazeCount++;
          audio.sfx.graze(run.combo);
          fx.burst(ev.a, ev.b, 4, {
            color: ['#FFD34F', pal.accent], speed: 260, size: 3, life: 0.3, shape: 3, drag: 0.9,
          });
          fx.shake(2.5, 9);
          if (run.combo % 10 === 0) {
            this.banner(`CHAIN ×${run.combo}`, 0.9);
            fx.flash('#FFFFFF', 0.22, 8);
            buzz(14);
          }
          break;
        }

        case 'gem':
          audio.sfx.gem();
          fx.burst(ev.a, ev.b, 18, {
            color: ['#FFD34F', '#FFFFFF'], speed: 420, size: 4, life: 0.6, shape: 2, drag: 0.92,
          });
          break;

        case 'scrape':
          audio.sfx.scrape();
          fx.shake(9, 6);
          fx.burst(ev.a, ev.b, 14, {
            color: [pal.accent, '#FFFFFF'], speed: 340, size: 3, life: 0.35, shape: 3, drag: 0.9,
          });
          buzz(20);
          break;

        case 'milestone':
          audio.sfx.milestone();
          this.banner(`${ev.a.toLocaleString()} m`, 1.1);
          this.loop.slowmo(1.15);
          setTimeout(() => this.loop.clearSlowmo(), 200);
          break;

        case 'biome':
          audio.sfx.biome();
          this.banner(ev.a, 1.8);
          fx.flash('#FFFFFF', 0.4, 5);
          fx.shake(10, 4);
          clearRockCache();
          break;

        case 'best':
          audio.sfx.best();
          this.banner('NEW RECORD', 1.4);
          fx.flash('#FFD34F', 0.4, 6);
          fx.burst(run.x, run.y, 60, {
            color: ['#FFD34F', '#FFFFFF'], speed: 560, size: 4, life: 0.9, shape: 3, drag: 0.92,
          });
          buzz(24);
          break;

        case 'death':
          this.deathAt = performance.now();
          audio.sfx.death();
          audio.stopMusic(0.12);
          audio.stopWhoosh();
          fx.shake(26, 2.4);
          fx.flash('#FFFFFF', 0.6, 6);
          fx.burst(run.x, run.y, 46, {
            color: ['#FFFFFF', pal.accent, pal.hazard], speed: 520, size: 5, life: 1.1, shape: 2, drag: 0.94,
          });
          break;

        default:
          break;
      }
    }
    run.events.length = 0;
  }

  // ---------------------------------------------------------------- render

  render(ctx, rawView) {
    const v = this.view;
    ctx.save();
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, rawView.w, rawView.h);
    ctx.translate(v.ox, v.oy);
    ctx.scale(v.scale, v.scale);
    ctx.beginPath();
    ctx.rect(0, 0, VW, v.vh);
    ctx.clip();

    this.ui.begin();
    const dt = Math.min(0.05, 1 / Math.max(20, this.loop.fps));

    if (this.screen === 'title') drawTitle(ctx, this, v, dt);
    else if (this.screen === 'hook') drawHook(ctx, this, v, dt);
    else if (this.screen === 'settings') drawSettings(ctx, this, v, dt);
    else this.renderDive(ctx, v, dt);

    this.ui.end(dt);
    ctx.restore();
  }

  renderDive(ctx, v, dt) {
    const run = this.run;
    if (!run) return;
    const R = this.renderer;
    const fx = this.fx;
    const pal = R.palette(run.depth);
    const cam = R.camera(run, v);
    run.predictArc();

    ctx.save();
    ctx.translate(fx.shakeX, fx.shakeY);

    // Zoom out slightly at speed, anchored on the diver.
    if (cam.zoom !== 1) {
      const cx = VW / 2;
      const cy = v.vh * 0.32;
      ctx.translate(cx, cy);
      ctx.scale(cam.zoom, cam.zoom);
      ctx.translate(-cx, -cy);
    }

    R.background(ctx, run, v, cam, pal, this.opt);
    R.speedLines(ctx, run, v, cam, pal, this.opt);
    R.walls(ctx, run, v, cam, pal, this.opt);
    R.world(ctx, run, v, cam, pal, this.opt);

    ctx.save();
    ctx.translate(0, -cam.y);
    fx.drawRings(ctx);
    fx.drawParticles(ctx);
    ctx.restore();

    R.diver(ctx, run, v, cam, pal, this.opt);
    R.collapse(ctx, run, v, cam, pal);
    ctx.restore();

    R.overlays(ctx, run, v, cam, pal, this.opt);
    fx.drawFlash(ctx, VW, v.vh);

    if (this.screen === 'play' || this.screen === 'pause') {
      drawHud(ctx, run, v, pal, this.opt, this.t);
    }
    if (this.screen === 'results') drawResults(ctx, this, v, dt);
    else if (this.screen === 'pause') drawPause(ctx, this, v, dt);
  }
}
