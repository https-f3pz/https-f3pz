// The controller.
//
// Owns layout, input translation, the economy clock, persistence and the screen
// dispatch. There is no run to start, pause or finish — the bore is always
// falling, and the app boots straight into it.
//
// The one subtlety worth stating up front: the economy advances on REAL elapsed
// time, not on the loop's scaled simulation time. Hitstop and slow-motion are
// presentation effects, and they must never rob the player of production.

import { VW, VH_MIN, VH_MAX, AUTO, OVERDRIVE, GOV_STEPS, PRESTIGE_STEPS, CHALLENGES, TIERS, LADDER, AWAY } from './config.js';
import { Renderer } from './render.js';
import { drawBore, drawBoards, drawAway, drawSettings } from './screens.js';
import { UI } from '../core/widgets.js';
import { load, save as writeSave, reset as resetSave, flushNow } from '../core/storage.js';
import { setHaptics, buzz } from '../core/input.js';
import { clamp } from '../core/draw.js';
import * as audio from '../core/audio.js';
import * as B from '../core/big.js';
import * as E from './economy.js';
import { makeWorld, updateWorld, flashBuy, flashPrestige, scaleOf, bandOf } from './world.js';
import { drawLayers, drawEscorts, spawnDust, layerNamesBetween } from './layers.js';
import { AwayClock, humanDuration } from '../core/awaytime.js';

/** Economy steps per second. Fine enough that autobuyers feel instant. */
const TICK_HZ = 20;
/** How often the save is written, and how often it is flushed to disk. */
const SAVE_EVERY = 10;
const FLUSH_EVERY = 30;

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
    this.clock = new AwayClock();

    this.screen = 'bore'; // bore | boards | away | settings
    this.board = 0; // 0 photon, 1 tau, 2 horizon
    this.t = 0;
    this.acc = 0;
    this.saveAcc = 0;
    this.flushAcc = 0;
    this.confirmReset = false;
    this.banner = '';
    this.bannerT = 0;
    this.ledger = null;
    this.primeCache = null;
    this.primeAt = -1;

    this.st = E.deserialize(this.save.economy);
    this.world = makeWorld();
    this.lastBand = -1;

    this.view = { vw: VW, vh: 1300, scale: 1, ox: 0, oy: 0, insetTop: 0, insetBottom: 0 };
    this.input = { taps: [], presses: [], releases: [], cancels: [], pointers: new Map(), primary: null };
    this.opt = { reduceGlow: false, quality: 1 };
    this.slowFrames = 0;
    this.fastFrames = 0;
  }

  init() {
    this.onResize(this.rawView);
    this.applySettings();
    this.resolveAway();
    // Seed the visual clock so a returning player does not watch it wind up.
    updateWorld(this.world, this.st, 0);
    this.lastBand = this.world.band;
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

  /** Snapshot the economy into the save blob. Cheap; called on a timer. */
  commit(flush = false) {
    writeSave({
      economy: E.serialize(this.st),
      clock: this.clock.stamp(this.save.clock),
    });
    if (flush) flushNow();
  }

  wipeSave() {
    this.save = resetSave();
    this.st = E.newState();
    this.world = makeWorld();
    this.confirmReset = false;
    this.applySettings();
    this.sfxBack();
  }

  sfxConfirm() { audio.sfx.uiConfirm(); }
  sfxBack() { audio.sfx.uiBack(); }

  // ------------------------------------------------------------- offline

  /**
   * Credit an absence and open the away panel. Called on boot, and again
   * whenever the page comes back from being hidden for more than a few
   * seconds — a backgrounded tab is an absence and must be paid like one.
   */
  resolveAway(minSeconds = 0) {
    const bandBefore = bandOf(scaleOf(this.st));
    const led = E.resolveOffline(this.st, this.save.clock);
    led.bandBefore = bandBefore;
    led.bandAfter = bandOf(scaleOf(this.st));
    // Persist the new high-water mark and bucket immediately, so reopening
    // cannot double-credit the same interval.
    writeSave({
      clock: { wall: Date.now(), mono: 0, high: led.high ?? Date.now(), budget: led.budget, suspect: !!this.save.clock?.suspect },
      economy: E.serialize(this.st),
    });
    flushNow();
    if (led.seconds > Math.max(minSeconds, 60) && !led.backwards && !led.missing) {
      this.ledger = led;
      this.screen = 'away';
    }
    return led;
  }

  // --------------------------------------------------------------- economy

  get state() {
    // main.js reloads for a service-worker update only when idle. The away
    // resolve must never be interrupted mid-ledger, so it reports as busy.
    return this.screen === 'away' ? 'play' : 'menu';
  }

  onBlur() {
    this.commit(true);
  }

  banner_(text, dur = 1.6) {
    this.banner = text;
    this.bannerT = dur;
  }

  /** The single best purchase right now, recomputed at 4 Hz, never per frame. */
  prime() {
    if (this.t - this.primeAt > 0.25) {
      this.primeAt = this.t;
      this.primeCache = E.primePick(this.st);
    }
    return this.primeCache;
  }

  buyTier(k, n) {
    const got = E.buy(this.st, k, n, { full: true });
    if (got > 0) {
      flashBuy(this.world);
      audio.sfx.gem();
      buzz(8);
      this.primeAt = -1;
    }
    return got;
  }

  buyMaxAll() {
    const got = E.maxAll(this.st);
    if (got > 0) {
      flashBuy(this.world);
      audio.sfx.attach();
      buzz(12);
      this.primeAt = -1;
    }
    return got;
  }

  doCollapse() {
    if (!E.canCollapse(this.st)) return;
    const g = E.collapse(this.st);
    flashPrestige(this.world);
    audio.sfx.best();
    audio.duckMusic?.();
    this.fx.flash('#ffd34f', 0.4, 3);
    this.banner_(`COLLAPSE — +${B.fmt(g)} PHOTONS`);
    buzz([20, 40]);
    this.commit(true);
  }

  doDilate() {
    if (!E.canDilate(this.st)) return;
    const g = E.dilate(this.st);
    flashPrestige(this.world);
    audio.sfx.whipcrack();
    audio.duckMusic?.();
    this.fx.flash('#8dffd0', 0.5, 2.4);
    this.banner_(`DILATE — +${B.fmt(g)} PROPER TIME`);
    buzz([30, 60]);
    this.commit(true);
  }

  doHorizon() {
    if (!E.canHorizon(this.st)) return;
    const n = E.horizon(this.st);
    flashPrestige(this.world);
    audio.sfx.death();
    audio.duckMusic?.();
    this.fx.flash('#ffffff', 0.6, 1.8);
    this.banner_(`EVENT HORIZON — +${n} OMEGA`);
    buzz([30, 60, 100]);
    this.commit(true);
  }

  /** Photon-board purchases. Returns true if something was bought. */
  spendPhotons(cost, apply) {
    const c = B.big(cost);
    if (B.lt(this.st.photons.bank, c)) return false;
    this.st.photons.bank = B.sub(this.st.photons.bank, c);
    apply();
    audio.sfx.uiConfirm();
    buzz(12);
    this.commit(true);
    return true;
  }

  spendTau(cost, apply) {
    const c = B.big(cost);
    if (B.lt(this.st.tau.bank, c)) return false;
    this.st.tau.bank = B.sub(this.st.tau.bank, c);
    apply();
    audio.sfx.uiConfirm();
    buzz(12);
    this.commit(true);
    return true;
  }

  // ----------------------------------------------------------------- frame

  beginFrame() {
    this.syncInput();
    this.clock.tick();
  }

  update(dt) {
    this.t += dt;
    this.renderer.t = this.t;
    this.watchQuality();
    if (this.bannerT > 0) this.bannerT -= dt;

    // The economy runs on REAL time at a fixed rate. `dt` here is the loop's
    // scaled sim time, which hitstop and slow-mo deliberately distort — using
    // it would let a screen-shake cost the player production.
    const real = Math.min(0.25, this.loop.lastReal ?? dt);
    this.acc += real;
    const stepDt = 1 / TICK_HZ;
    let steps = 0;
    while (this.acc >= stepDt && steps < 8) {
      E.step(this.st, E.properTime(this.st, stepDt));
      this.acc -= stepDt;
      steps++;
    }
    if (steps >= 8) this.acc = 0;
    this.drainEvents();

    updateWorld(this.world, this.st, real);
    if (this.world.band > this.lastBand) {
      // Bands crossed while the player was away are reported on the away panel
      // instead; firing ten full-screen events at once on resume is a mess.
      if (this.screen === 'away') this.lastBand = this.world.band;
      else this.onBand(this.world.band);
    }

    spawnDust(this.fx, this.renderer, this.world, this.renderer.pal ?? { edge: '#57e0ff' }, real);
    this.fx.update(dt);

    this.saveAcc += real;
    this.flushAcc += real;
    if (this.saveAcc >= SAVE_EVERY) {
      this.saveAcc = 0;
      this.commit(this.flushAcc >= FLUSH_EVERY);
      if (this.flushAcc >= FLUSH_EVERY) this.flushAcc = 0;
    }
  }

  drainEvents() {
    for (const ev of this.st.events) {
      if (ev.type === 'milestone') {
        audio.sfx.milestone?.();
        this.fx.ring(this.renderer.cx, this.renderer.cy, 40, 220, '#ffd34f', 0.4, 3);
      } else if (ev.type === 'collapse' || ev.type === 'dilate' || ev.type === 'horizon') {
        flashPrestige(this.world);
      }
    }
    this.st.events.length = 0;
  }

  /** A band crossing is a full-screen event and, sometimes, a new layer. */
  onBand(band) {
    const names = layerNamesBetween(this.lastBand, band);
    this.lastBand = band;
    this.fx.flash('#ffffff', 0.35, 3);
    this.fx.ring(this.renderer.cx, this.renderer.cy, 20, 420, '#ffffff', 0.6, 5);
    this.fx.burst(this.renderer.cx, this.renderer.cy, 24, { color: '#ffffff', speed: 320, life: 0.8 });
    audio.sfx.biome();
    audio.duckMusic?.();
    this.banner_(names.length ? `${names[0]} ONLINE` : `DEPTH FIELD ${band}`, 2.2);
  }

  // A device that cannot hold the frame should lose an effect, not the game.
  watchQuality() {
    const fps = this.loop.fps;
    if (fps < 52) { this.slowFrames++; this.fastFrames = 0; }
    else if (fps > 58) { this.fastFrames++; this.slowFrames = 0; }
    if (this.slowFrames > 45 && this.opt.quality === 1) { this.opt.quality = 0; this.slowFrames = 0; }
    else if (this.fastFrames > 240 && this.opt.quality === 0) { this.opt.quality = 1; this.fastFrames = 0; }
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

    this.drawTunnel(ctx, v);

    if (this.screen === 'boards') drawBoards(ctx, this, v, dt);
    else if (this.screen === 'away') drawAway(ctx, this, v, dt);
    else if (this.screen === 'settings') drawSettings(ctx, this, v, dt);
    else drawBore(ctx, this, v, dt);

    this.ui.end(dt);
    ctx.restore();
  }

  /** The tunnel is the background of every screen, always live. */
  drawTunnel(ctx, v) {
    const R = this.renderer;
    const w = this.world;
    const pal = R.palette(w.dist);
    this.renderer.pal = pal;
    R.setup(w, v);

    ctx.save();
    ctx.translate(this.fx.shakeX, this.fx.shakeY);
    R.background(ctx, w, v, pal);
    R.tube(ctx, w, v, pal, this.opt);
    drawLayers(ctx, R, w, this.st, v, pal, this.opt);
    R.ship(ctx, w, v, pal);
    drawEscorts(ctx, R, w, this.st, pal);
    this.fx.drawParticles(ctx);
    ctx.restore();

    R.overlays(ctx, w, v, pal, this.opt);
    this.fx.drawRings(ctx);
    this.fx.drawFlash(ctx, VW, v.vh);
  }

  // ----------------------------------------------------------- debug hooks
  // tools/playtest.mjs drives the game through these. Keep them.

  snapshot() {
    return {
      state: this.state,
      screen: this.screen,
      depth: B.fmt(this.st.depth),
      logDepth: B.log10(this.st.depth),
      rate: B.fmt(E.rate(this.st)),
      photons: B.fmt(this.st.photons.bank),
      tau: B.fmt(this.st.tau.bank),
      omega: this.st.omega.total,
      tiers: this.st.tiers,
      owned: this.st.owned.slice(1, this.st.tiers + 1),
      collapses: this.st.collapses,
      warp: this.world.warp,
      band: this.world.band,
      fps: Math.round(this.loop.fps),
    };
  }

  debugGrant(logDepth) {
    this.st.depth = B.pow10(logDepth);
  }

  /** Advance the economy by `seconds` of wall time, in offline-sized chunks. */
  debugAdvance(seconds) {
    let left = Math.max(0, seconds);
    while (left > 0) {
      const w = Math.min(60, left);
      left -= w;
      E.step(this.st, E.properTime(this.st, w));
    }
    this.st.events.length = 0;
    updateWorld(this.world, this.st, 0);
    this.lastBand = this.world.band;
  }
}
