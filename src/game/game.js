// REDSHIFT — top-level state machine.
//
// Owns the virtual-space transform, the screen stack, the run lifecycle, and
// the translation of simulation events into sound and shake. The Run knows
// nothing about screens; the screens know nothing about the simulation.

import { VW, VH_MIN, VH_MAX, SPEED, WARP } from './config.js';
import { Run } from './run.js';
import { Renderer } from './render.js';
import { drawHud } from './hud.js';
import { drawTitle, drawShip, drawSettings, drawResults, drawPause } from './screens.js';
import { UI } from '../core/widgets.js';
import { hashSeed, randomSeedWord } from '../core/rng.js';
import { load, save as writeSave, reset as resetSave } from '../core/storage.js';
import { recordRun, coachingLine, dailySeed, todayKey, buyUpgrade } from './meta.js';
import { setHaptics, buzz } from '../core/input.js';
import { clamp } from '../core/draw.js';
import * as audio from '../core/audio.js';

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

    this.screen = 'title'; // title | ship | settings | play | results | pause
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
    this.run.bestCleanGates = 0;

    this.fx.clear();
    this.loop.clearSlowmo();
    this.loop.hitstop = 0;
    this.screen = 'play';
    audio.unlock();
    audio.startMusic();
    this.maybeTip('DRAG TO ROLL · SKIM THE EDGES', 3.4);
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
      runTime: r ? r.dist / Math.max(1, SPEED.start) : 0,
      dist: r ? Math.round(r.dist) : 0,
      score: r ? Math.round(r.score) : 0,
      speed: r ? Math.round(r.speed) : 0,
      warp: r ? Math.round(r.warp * 100) : 0,
      combo: r ? r.combo : 0,
      gates: r ? r.gates : 0,
      clips: r ? r.clips : 0,
      fps: Math.round(this.loop.fps),
    };
  }

  get state() {
    if (this.screen === 'play') return this.run && this.run.dead ? 'over' : 'play';
    if (this.screen === 'results') return 'over';
    return this.screen === 'pause' ? 'pause' : 'menu';
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

  banner(text, dur = 1.4) {
    if (!this.run) return;
    this.run.banner = text;
    this.run.bannerT = dur;
  }

  // ------------------------------------------- per-frame discrete input

  beginFrame() {
    this.syncInput();
    if (this.screen !== 'play' || !this.run || this.run.dead) return;
    // Pause sits in the top-left corner, clear of the play surface.
    const pb = { x: 0, y: this.view.insetTop, w: 110, h: 110 };
    for (const p of this.input.presses) {
      if (p.x >= pb.x && p.x <= pb.x + pb.w && p.y >= pb.y && p.y <= pb.y + pb.h) {
        this.pause();
        return;
      }
    }
  }

  // --------------------------------------------------------------- update

  update(dt) {
    this.t += dt;
    this.renderer.t = this.t;
    this.watchQuality();

    if (this.screen === 'play') this.updatePlay(dt);
    else if (this.screen === 'results') {
      const target = this.run ? this.run.dist : 0;
      if (this.countUp < target) {
        this.countUp = Math.min(target, this.countUp + Math.max(target / 0.9, 400) * dt);
      }
    }
    this.fx.update(dt);
  }

  // A device that cannot hold the frame should lose an effect, not the game.
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
      if (since > 600) this.loop.clearSlowmo();
      else this.loop.slowmo(0.3);
      if (since > 1400 && this.screen === 'play') {
        this.finishRun();
        this.countUp = 0;
        this.screen = 'results';
        this.loop.clearSlowmo();
      }
      return;
    }

    const id = this.input.primary;
    const p = id != null ? this.input.pointers.get(id) : null;
    run.update(dt, p ? { x: p.x, y: p.y } : null);
    run.bestCleanGates = Math.max(run.bestCleanGates ?? 0, run.cleanGates);
    this.handleEvents();

    if (run.tipT > 0) run.tipT -= dt;
    if (run.bannerT > 0) run.bannerT -= dt;

    // The whoosh and the music both ride the warp, so the mix is a second
    // speed readout for anyone not looking at the bar.
    audio.setWhoosh(run.speed * 0.62);
    audio.setIntensity(run.warp);

    // Above the shake threshold the frame itself starts to buzz — the last
    // and least subtle of the velocity distortions.
    if (run.warp > WARP.shakeAt) {
      this.fx.shake((run.warp - WARP.shakeAt) * 10, 14);
    }

    if (run.combo >= 4) this.maybeTip('CHAINED GRAZES ARE WORTH FAR MORE', 2.8);
    if (run.warp > 0.6) this.maybeTip('THE VIEW IS LYING NOW — TRUST THE GAPS', 3.0);
    // The two halves of the loop, taught the moment each one first bites.
    if (run.clips >= 1 && run.grazes === 0) this.maybeTip('ONLY NEAR MISSES REPAIR THE HULL', 3.0);
    if (run.warp >= run.shatter) this.maybeTip('PAST THE MARK, ONE SCRAPE ENDS IT', 3.0);
  }

  handleEvents() {
    const run = this.run;
    const fx = this.fx;
    const pal = this.renderer.palette(run.dist);

    for (const ev of run.events) {
      switch (ev.type) {
        case 'graze':
          audio.sfx.graze(ev.a);
          fx.shake(2.5, 10);
          if (ev.a % 10 === 0) {
            this.banner(`CHAIN ×${ev.a}`, 0.9);
            fx.flash('#FFFFFF', 0.18, 8);
            buzz(14);
          }
          break;

        case 'clip':
          audio.sfx.scrape();
          fx.shake(14, 5);
          fx.flash('#ff2020', 0.3, 7);
          break;

        case 'milestone':
          audio.sfx.milestone();
          this.banner(ev.a.toLocaleString(), 1.0);
          break;

        case 'zone':
          audio.sfx.biome();
          this.banner(ev.a, 1.8);
          fx.flash('#FFFFFF', 0.35, 5);
          fx.shake(9, 4);
          break;

        case 'best':
          audio.sfx.best();
          this.banner('NEW RECORD', 1.4);
          fx.flash('#FFD34F', 0.35, 6);
          buzz(24);
          break;

        case 'death':
          this.deathAt = performance.now();
          audio.sfx.death();
          audio.stopMusic(0.12);
          audio.stopWhoosh();
          fx.shake(24, 2.4);
          fx.flash('#FFFFFF', 0.55, 6);
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
    else if (this.screen === 'ship') drawShip(ctx, this, v, dt);
    else if (this.screen === 'settings') drawSettings(ctx, this, v, dt);
    else this.renderRun(ctx, v, dt);

    this.ui.end(dt);
    ctx.restore();
  }

  renderRun(ctx, v, dt) {
    const run = this.run;
    if (!run) return;
    const R = this.renderer;
    const pal = R.palette(run.dist);
    R.setup(run, v);

    ctx.save();
    ctx.translate(this.fx.shakeX, this.fx.shakeY);
    R.background(ctx, run, v, pal);
    R.tube(ctx, run, v, pal, this.opt);
    R.obstacles(ctx, run, v, pal, this.opt);
    R.ship(ctx, run, v, pal);
    this.fx.drawParticles(ctx);
    ctx.restore();

    R.overlays(ctx, run, v, pal, this.opt);
    this.fx.drawFlash(ctx, VW, v.vh);

    if (this.screen === 'play' || this.screen === 'pause') drawHud(ctx, run, v, pal, this.opt, this.t);
    if (this.screen === 'results') drawResults(ctx, this, v, dt);
    else if (this.screen === 'pause') drawPause(ctx, this, v, dt);
  }
}
