// FLASHOVER — top-level state machine.
//
// Owns the logical-space transform, the screen stack, the run lifecycle, and
// the translation from simulation events into sound and particles. The Run
// knows nothing about screens; the screens know nothing about the simulation.

import {
  VW, VH_MIN, VH_MAX, C, HEAT, MUTATORS, DRAFT_TIMES, PRESSURE, baseStats,
} from './config.js';
import { Run } from './run.js';
import { Renderer, heatColor } from './render.js';
import { drawHud } from './hud.js';
import { drawTitle, drawSettings, drawDraft, drawResults, drawPause } from './screens.js';
import { UI } from '../core/widgets.js';
import { makeRng, hashSeed, randomSeedWord } from '../core/rng.js';
import { load, save as writeSave, reset as resetSave } from '../core/storage.js';
import { recordRun, coachingLine, coreById, dailySeed, todayKey } from './meta.js';
import { setHaptics, buzz } from '../core/input.js';
import { clamp, lerp } from '../core/draw.js';
import * as audio from '../core/audio.js';

const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

export class Game {
  constructor({ ctx, view, input, fx, loop, audio: aud }) {
    this.ctx = ctx;
    this.rawView = view;
    this.rawInput = input;
    this.fx = fx;
    this.loop = loop;
    this.audio = aud || audio;

    this.save = load();
    this.ui = new UI();
    this.renderer = new Renderer(fx);

    this.screen = 'title'; // title | settings | play | draft | results | pause
    this.t = 0;
    this.run = null;
    this.result = null;
    this.countUp = 0;
    this.coach = '';
    this.confirmReset = false;
    this.isDaily = false;
    this.picks = [];
    this.draftCards = [];
    this.draftIndex = 0;
    this.draftT = 0;
    this.pendingDraft = 0;
    this.newBestLive = false;

    // Logical-space view, recomputed on every resize.
    this.view = { vw: VW, vh: 640, scale: 1, ox: 0, oy: 0, insetTop: 0, insetBottom: 0 };

    // Input mirrored into logical space. Screens, widgets and the ship all
    // read this; only the vent's cancel guard talks to the raw device input.
    this.input = {
      taps: [], presses: [], releases: [], cancels: [], pointers: new Map(), primary: null,
    };
  }

  init() {
    this.onResize(this.rawView);
    this.applySettings();
  }

  // --------------------------------------------------------------- layout

  onResize(view) {
    if (!view) return;
    this.rawView = view;
    const aspectH = VW * (view.h / Math.max(1, view.w));
    const vh = clamp(aspectH, VH_MIN, VH_MAX);
    const scale = Math.min(view.w / VW, view.h / vh);
    this.view.vh = vh;
    this.view.scale = scale;
    this.view.ox = (view.w - VW * scale) / 2;
    this.view.oy = (view.h - vh * scale) / 2;
    this.view.insetTop = view.safe.top / scale;
    this.view.insetBottom = view.safe.bottom / scale;
    if (this.run) this.run.layout(this.view);
  }

  toLogical(p) {
    return { x: (p.x - this.view.ox) / this.view.scale, y: (p.y - this.view.oy) / this.view.scale };
  }

  syncInput() {
    const li = this.input;
    li.taps.length = 0;
    li.presses.length = 0;
    li.releases.length = 0;
    li.cancels.length = 0;
    li.pointers.clear();
    for (const t of this.rawInput.taps) li.taps.push({ ...t, ...this.toLogical(t) });
    for (const p of this.rawInput.presses) li.presses.push({ ...p, ...this.toLogical(p) });
    for (const r of this.rawInput.releases) li.releases.push({ ...r, ...this.toLogical(r) });
    for (const c of this.rawInput.cancels) li.cancels.push({ ...c, ...this.toLogical(c) });
    for (const [id, p] of this.rawInput.pointers) li.pointers.set(id, { ...p, ...this.toLogical(p) });
    li.primary = this.rawInput.primary;
  }

  // ------------------------------------------------------------- settings

  applySettings() {
    const s = this.save.settings;
    setHaptics(!!s.haptics);
    audio.configure({ sound: !!s.sound, music: !!s.music });
    // reduceMotion thins particle counts; shakeScale owns camera shake. They
    // are separate knobs and must not be multiplied together.
    this.fx.reduceMotion = !!s.reduceGlow;
    this.fx.shakeScale = s.reduceShake ?? 1;
    this.opt = {
      highContrast: !!s.highContrast,
      reduceGlow: !!s.reduceGlow,
      newBestLive: false,
    };
    writeSave({ settings: s });
  }

  persist(patch) {
    writeSave(patch);
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

  buildStats(coreId, pressure, picks) {
    const s = baseStats();
    coreById(coreId).apply(s);
    for (let i = 0; i < pressure; i++) PRESSURE[i].apply(s);
    for (const id of picks) {
      const m = MUTATORS.find((x) => x.id === id);
      if (m) m.apply(s);
    }
    // A fresh save gets a quietly gentler first few runs. It switches itself
    // off for good once the player has proved they don't need it.
    const assisted = (this.save.bestTime || 0) < 60;
    if (assisted) {
      const r = this.save.runs || 0;
      s.density *= r === 0 ? 0.62 : r === 1 ? 0.78 : r === 2 ? 0.9 : 1;
    }
    return s;
  }

  beginRun({ daily = false } = {}) {
    this.isDaily = daily;
    this.picks = [];
    this.draftIndex = 0;
    this.pendingDraft = 0;
    this.confirmReset = false;
    this.newBestLive = false;
    this.opt.newBestLive = false;
    this.recorded = false; // a run is written to the save exactly once

    const coreId = daily ? 'needle' : this.save.core || 'needle';
    const pressure = daily ? 0 : Math.min(this.save.pressure ?? 0, this.save.cores?.[coreId]?.bestPressure ?? 0);
    const seed = daily ? dailySeed() : hashSeed(randomSeedWord() + Date.now());
    this.seedWord = daily ? `DAILY ${todayKey()}` : String(seed % 100000);

    this.runCoreId = coreId;
    this.runPressure = pressure;

    this.run = new Run({
      stats: this.buildStats(coreId, pressure, this.picks),
      seed,
      rng: makeRng(seed),
      fx: this.fx,
      loop: this.loop,
      view: this.view,
      save: this.save,
    });
    this.run.bestKnown = this.save.best || 0;
    this.run.displayScore = 0;
    this.run.gaugePop = 0;
    this.run.tip = '';
    this.run.tipT = 0;

    this.fx.clear();
    this.loop.clearSlowmo();
    this.loop.hitstop = 0;
    this.screen = 'play';
    audio.unlock();
    audio.startMusic();
    this.maybeTip('DRAG TO FLY · HUG THE BULLETS', 3.2);
  }

  endRunEarly() {
    this.finishRun();
    this.screen = 'title';
    audio.stopMusic();
  }

  finishRun() {
    if (!this.run || this.recorded) return;
    this.recorded = true;
    const declinedAll = this.picks.length === 0 && this.draftIndex > 0;
    this.result = recordRun(this.save, this.run, {
      coreId: this.runCoreId,
      pressure: this.runPressure,
      isDaily: this.isDaily,
      declinedAll,
    });
    this.coach = coachingLine(this.run);
  }

  debugKill() {
    if (this.run && this.screen === 'play') this.run.killNow();
  }

  startRun(seed) {
    this.beginRun({ daily: false });
    return seed;
  }

  snapshot() {
    return {
      state: this.state,
      screen: this.screen,
      runTime: this.run ? this.run.time : 0,
      score: this.run ? Math.round(this.run.score) : 0,
      heat: this.run ? Math.round(this.run.heat) : 0,
      enemies: this.run ? this.run.world.enemies.count : 0,
      projectiles: this.run ? this.run.world.proj.count : 0,
      flashovers: this.run ? this.run.flashCount : 0,
      vents: this.run ? this.run.ventCount : 0,
      fps: Math.round(this.loop.fps),
      picks: [...this.picks],
    };
  }

  // Coarse state, used by the play-test harness and main.js.
  get state() {
    if (this.screen === 'play') return this.run && this.run.dead ? 'over' : 'play';
    if (this.screen === 'results') return 'over';
    return this.screen === 'title' || this.screen === 'settings' ? 'menu' : this.screen;
  }

  onBlur() {
    if (this.screen === 'play' && this.run && !this.run.dead) this.pause();
  }

  pause() {
    if (this.screen !== 'play') return;
    this.screen = 'pause';
    audio.stopMusic(0.15);
  }

  resume() {
    if (this.screen !== 'pause') return;
    this.screen = 'play';
    this.loop.last = performance.now();
    audio.startMusic();
    // Give the player a moment to re-read the field before it moves again.
    this.resumeRamp = 0.6;
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

  // ---------------------------------------------------------------- draft

  openDraft() {
    const available = MUTATORS.filter((m) => !this.picks.includes(m.id));
    if (!available.length) {
      this.draftIndex++;
      return;
    }
    const rng = makeRng(this.run.seed + this.draftIndex * 7919);
    rng.shuffle(available);
    this.draftCards = available.slice(0, 3);
    this.draftT = 0;
    this.screen = 'draft';
    // Hard pause: dying while reading a card is impossible.
    audio.duckMusic(0.3, 1.2);
    audio.sfx.levelUp();
  }

  pickMutator(m) {
    if (m) {
      this.picks.push(m.id);
      // Rebuild the whole stat block so mutator order can never matter.
      this.run.s = this.buildStats(this.runCoreId, this.runPressure, this.picks);
      audio.sfx.unlock();
      buzz(18);
      this.fx.flash('#ffffff', 0.3, 6);
    } else {
      this.sfxBack();
    }
    this.draftIndex++;
    this.screen = 'play';
    this.resumeRamp = 0.6;
  }

  // --------------------------------------------------------------- update

  // Once per rendered frame, before any substep. Everything discrete — taps,
  // releases, vents, pause — is handled here exactly once, because the number
  // of substeps in a frame varies from zero to eight.
  beginFrame() {
    this.syncInput();
    if (this.screen === 'play' && this.run && !this.run.dead) this.handleFrameInput();
  }

  handleFrameInput() {
    const run = this.run;

    // Pause button, top-left, outside the play column.
    const pb = { x: 2, y: this.view.insetTop - 2, w: 34, h: 34 };
    for (const t of this.input.taps) {
      if (t.x >= pb.x && t.x <= pb.x + pb.w && t.y >= pb.y && t.y <= pb.y + pb.h) {
        this.pause();
        return;
      }
    }

    if (this.save.settings.ventMode === 'secondTap') {
      // A second finger vents; the steering finger is never disturbed.
      for (const p of this.input.presses) {
        if (p.count >= 2) run.requestVent();
      }
    } else {
      for (const r of this.input.releases) {
        if (!r.wasPrimary) continue;
        // Guard rails so an accidental lift never costs a run: it must have
        // been a deliberate hold, and it must not follow a pointercancel.
        if (r.duration < 150) continue;
        if (this.rawInput.cancelledRecently(200)) continue;
        run.requestVent();
      }
    }
  }

  update(dt) {
    this.t += dt;
    this.renderer.t = this.t;

    if (this.screen === 'play') this.updatePlay(dt);
    else if (this.screen === 'results') this.updateResults(dt);

    this.fx.update(dt);
  }

  updateResults(dt) {
    const target = this.run ? this.run.score : 0;
    if (this.countUp < target) {
      // Count up fast enough to feel like a payout, slow enough to be a beat.
      const step = Math.max(target / 1.1, 400) * dt;
      const before = this.countUp;
      this.countUp = Math.min(target, this.countUp + step);
      if (Math.floor(this.countUp / 1000) > Math.floor(before / 1000)) audio.sfx.uiMove();
    }
    // Let the wreckage keep falling behind the card.
    if (this.run) this.run.updateProjectilesDying(dt);
  }

  updatePlay(dt) {
    const run = this.run;
    if (!run) return;

    // Resume ramp after a draft or a pause.
    if (this.resumeRamp > 0) {
      this.resumeRamp -= dt;
      this.loop.slowmo(lerp(0.35, 1, 1 - clamp(this.resumeRamp / 0.6, 0, 1)));
      if (this.resumeRamp <= 0) this.loop.clearSlowmo();
    }

    if (run.dead) {
      run.update(dt, null);
      this.handleEvents();
      // Wall-clock, deliberately: the death sequence runs in slow motion, so
      // timing it in simulated seconds would stretch a 1.5s beat into 6.
      const since = performance.now() - (this.deathAt ?? performance.now());
      if (since > 900) this.loop.clearSlowmo();
      else this.loop.slowmo(0.25);
      if (since > 1500 && this.screen === 'play') {
        this.finishRun();
        this.countUp = 0;
        this.screen = 'results';
        this.loop.clearSlowmo();
      }
      return;
    }

    // -------- steering (continuous; the discrete events were latched in
    // beginFrame, which runs exactly once per frame)
    const steerId = this.input.primary;
    const touch = steerId != null ? this.input.pointers.get(steerId) : null;
    const mode = this.save.settings.ventMode;

    // A vent's invulnerability extends while the finger is off the glass, so
    // "I lifted by mistake" can never be lethal.
    if (!touch && run.ventCd > 0 && run.iframes > 0) {
      run.iframes = Math.min(HEAT.ventIFramesMax, run.iframes + dt);
    }

    run.update(dt, touch);
    this.handleEvents();

    // -------- HUD animation state
    run.displayScore = lerp(run.displayScore ?? 0, run.score, Math.min(1, dt * 14));
    run.gaugePop = Math.max(0, (run.gaugePop ?? 0) - dt * 22);
    if (run.tipT > 0) run.tipT -= dt;

    // The best moment of a run should never wait for the results screen.
    if (!this.newBestLive && run.score > (this.save.best || 0) && (this.save.best || 0) > 0) {
      this.newBestLive = true;
      this.opt.newBestLive = true;
      this.fx.burst(VW / 2, this.view.insetTop + 22, 60, {
        color: [C.gold, '#FFFFFF'], speed: 200, size: 2.6, life: 0.7, shape: 3, drag: 0.9,
      });
      audio.sfx.perfect(7);
      buzz(20);
    }

    // -------- drafts
    if (this.draftIndex < DRAFT_TIMES.length && run.time >= DRAFT_TIMES[this.draftIndex]) {
      this.openDraft();
    }

    // -------- contextual teaching, at the exact moment it applies
    if (run.heat >= HEAT.ventGate && run.armedT > 0.4) {
      this.maybeTip(mode === 'lift' ? 'ARMED · LIFT YOUR THUMB TO VENT' : 'ARMED · TAP A SECOND FINGER', 3.0);
    }
    if (run.heat >= 80) this.maybeTip('PUSH TO 100 AND YOU IGNITE', 2.6);
  }

  // Translates simulation events into sound, particles and shake. Keeping
  // this in one place means the Run never has to know they exist.
  handleEvents() {
    const run = this.run;
    const fx = this.fx;

    for (const ev of run.events) {
      switch (ev.type) {
        case 'shoot':
          break;

        case 'grazeSpark': {
          // The most important particle in the game: danger visibly feeding
          // you. It flies from the threat into the hull.
          const w = run.world;
          const pick = w.proj.count ? w.proj.items[(Math.random() * w.proj.count) | 0] : null;
          const src = pick || (w.enemies.count ? w.enemies.items[(Math.random() * w.enemies.count) | 0] : null);
          if (src) {
            const a = Math.atan2(run.y - src.y, run.x - src.x);
            fx.particle(src.x, src.y, Math.cos(a) * 260, Math.sin(a) * 260, {
              life: 0.22, size: 1.6, color: heatColor(run.heat), drag: 0.99, shape: 3,
            });
          }
          break;
        }

        case 'heatRung':
          audio.sfx.perfect(Math.min(11, ev.a));
          run.gaugePop = 6;
          break;

        case 'ventArmed':
          audio.sfx.uiConfirm();
          run.gaugePop = 6;
          break;

        case 'vent': {
          audio.sfx.shieldBreak();
          fx.shake(10, 5);
          fx.ring(run.x, run.y, 0, run.s.ventRadius, '#FFFFFF', 0.3, 5);
          fx.burst(run.x, run.y, 40, {
            color: ['#FFFFFF', C.hull], speed: 320, size: 2.4, life: 0.5, shape: 3, drag: 0.9,
          });
          fx.flash('#FFFFFF', 0.22, 8);
          break;
        }

        case 'flashEnter':
          audio.sfx.rush();
          audio.duckMusic(0.4, 0.5);
          fx.flash('#FFFFFF', 0.85, 9);
          fx.shake(16, 4);
          fx.burst(run.x, run.y, 70, {
            color: ['#FFFFFF', C.gold, C.pellet], speed: 420, size: 3, life: 0.9, shape: 2, drag: 0.92,
          });
          break;

        case 'flashEnd':
          audio.sfx.uiBack();
          break;

        case 'kill':
          this.killFx(ev.a, ev.b, false);
          break;

        case 'bossKill':
          this.killFx(ev.a, ev.b, true);
          break;

        case 'bloomBurst':
          audio.sfx.bounce();
          fx.ring(ev.a, ev.b, 6, 60, C.orb, 0.3, 3);
          break;

        case 'bloomInflate':
          audio.tone({ freq: 200, freq2: 700, type: 'sawtooth', dur: 0.85, gain: 0.1 });
          break;

        case 'lancerTelegraph':
          audio.tone({ freq: 300, freq2: 1200, type: 'sawtooth', dur: 0.48, gain: 0.12 });
          break;

        case 'enemyFire':
          audio.tone({ freq: 320, type: 'square', dur: 0.04, gain: 0.05 });
          break;

        case 'pip':
          audio.tone({ freq: 1400, type: 'sine', dur: 0.025, gain: 0.09 });
          break;

        case 'era':
          audio.sfx.levelUp();
          fx.flash('#FFFFFF', 0.4, 5);
          fx.shake(7, 4);
          break;

        case 'spark':
          audio.sfx.unlock();
          audio.tone({ freq: 1800, freq2: 220, type: 'sine', dur: 0.7, gain: 0.25 });
          fx.flash('#FFFFFF', 0.85, 3);
          fx.shake(18, 3);
          break;

        case 'mercy':
          audio.sfx.warn();
          fx.flash(C.hull, 0.4, 6);
          break;

        case 'death':
          this.deathAt = performance.now();
          audio.sfx.death();
          audio.stopMusic(0.12);
          fx.shake(22, 2.4);
          fx.flash('#FFFFFF', 0.6, 6);
          fx.burst(run.x, run.y, 90, {
            color: ['#FFFFFF', C.hull, C.pellet], speed: 380, size: 3, life: 1.2, shape: 2, drag: 0.94,
          });
          break;
      }
    }
    run.events.length = 0;
  }

  killFx(x, y, boss) {
    const fx = this.fx;
    // Kills only chain-pitch upward while they are genuinely consecutive.
    const now = this.t;
    if (now - (this.lastKillT ?? -9) < 0.7) this.killChain = Math.min(12, (this.killChain ?? 0) + 1);
    else this.killChain = 0;
    this.lastKillT = now;

    audio.sfx.shatter(this.killChain);
    // Never eat the player's panic response with a freeze frame.
    if (!run_isVenting(this.run)) this.loop.freeze(boss ? 0.26 : 0.045);
    fx.shake(boss ? 18 : 4, boss ? 3 : 8);
    fx.burst(x, y, boss ? 60 : 10, {
      color: boss ? [C.husk, '#FFFFFF', C.gold] : [C.pellet, '#FFFFFF'],
      speed: boss ? 340 : 200, size: boss ? 3 : 2, life: boss ? 0.9 : 0.45, shape: 3, drag: 0.93,
    });
    if (boss) {
      fx.flash('#FFFFFF', 0.5, 5);
      fx.ring(x, y, 10, 200, C.gold, 0.5, 4);
      fx.text(x, y - 20, `+${Math.round(2000 * this.run.scoreMult).toLocaleString()}`, C.gold, 18, 1.0);
    }
  }

  // ---------------------------------------------------------------- render

  render(ctx, rawView) {
    const v = this.view;
    ctx.save();
    // Letterbox anything the logical space doesn't cover.
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
    else if (this.screen === 'settings') drawSettings(ctx, this, v, dt);
    else this.renderGame(ctx, v, dt);

    this.ui.end(dt);
    ctx.restore();
  }

  renderGame(ctx, v, dt) {
    const run = this.run;
    if (!run) return;
    const opt = this.opt;
    const fx = this.fx;

    ctx.save();
    // Screenshake is applied to the world only — the HUD stays legible.
    ctx.translate(fx.shakeX, fx.shakeY);
    this.renderer.background(ctx, run, v, opt);
    this.renderer.world(ctx, run, v, opt);
    fx.drawRings(ctx);
    fx.drawParticles(ctx);
    // Both of these go ABOVE the particle layer on purpose: a big burst must
    // never be able to hide a bullet's white core or the player's own hitbox.
    this.renderer.projectileCores(ctx, run, opt);
    this.renderer.player(ctx, run, opt);
    ctx.restore();

    this.renderer.overlays(ctx, run, v, opt);
    fx.drawFlash(ctx, VW, v.vh);
    fx.drawTexts(ctx, FONT);

    if (this.screen === 'play' || this.screen === 'pause' || this.screen === 'draft') {
      drawHud(ctx, run, v, opt, this.t);
      this.drawPauseButton(ctx, v, dt);
    }

    if (this.screen === 'draft') {
      this.draftT += dt;
      drawDraft(ctx, this, v, dt);
    } else if (this.screen === 'results') {
      drawResults(ctx, this, v, dt);
    } else if (this.screen === 'pause') {
      drawPause(ctx, this, v, dt);
    }
  }

  drawPauseButton(ctx, v, dt) {
    if (this.screen !== 'play') return;
    ctx.save();
    ctx.globalAlpha = 0.4;
    ctx.fillStyle = C.dim;
    ctx.fillRect(12, v.insetTop + 8, 3, 11);
    ctx.fillRect(18, v.insetTop + 8, 3, 11);
    ctx.restore();
  }
}

// A vent is the player's panic button; freezing the frame during one would
// eat exactly the input they are relying on.
function run_isVenting(run) {
  return !!(run && run.ventRing);
}
