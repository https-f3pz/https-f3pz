// Headless play-test harness.
//
// Boots the game in a mobile-emulated Chromium, drives it with synthetic touch
// input, and asserts the things that actually break on phones: console errors,
// frame budget, offline boot from the service worker cache, and that a real
// run can start, score, and end.
//
//   node tools/playtest.mjs            # full suite
//   node tools/playtest.mjs --shots    # also write screenshots to .playtest/
//
// Playwright is resolved from the global install so the repo stays
// dependency-free — the game itself has no build step and no node_modules.

import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const ROOT = resolve(new URL('..', import.meta.url).pathname);
const SHOTS = process.argv.includes('--shots');
const SHOT_DIR = join(ROOT, '.playtest');

function loadPlaywright() {
  const candidates = [
    'playwright',
    '/opt/node22/lib/node_modules/playwright',
    '/usr/lib/node_modules/playwright',
    '/usr/local/lib/node_modules/playwright',
  ];
  for (const c of candidates) {
    try {
      return require_(c);
    } catch {
      /* try the next location */
    }
  }
  throw new Error('Playwright not found. Install it globally: npm i -g playwright');
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function serve(root) {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      let p = decodeURIComponent(url.pathname);
      if (p.endsWith('/')) p += 'index.html';
      const file = join(root, normalize(p).replace(/^(\.\.[/\\])+/, ''));
      if (!file.startsWith(root) || !existsSync(file)) {
        res.writeHead(404);
        res.end('not found');
        return;
      }
      const body = await readFile(file);
      res.writeHead(200, {
        'Content-Type': MIME[extname(file)] || 'application/octet-stream',
        // A service worker will not register over a stale cached shell.
        'Cache-Control': 'no-cache',
        'Service-Worker-Allowed': '/',
      });
      res.end(body);
    } catch (err) {
      res.writeHead(500);
      res.end(String(err));
    }
  });
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok({ server, port: server.address().port })));
}

const results = [];
function check(name, pass, detail = '') {
  results.push({ name, pass, detail });
  const mark = pass ? '\x1b[32m PASS \x1b[0m' : '\x1b[31m FAIL \x1b[0m';
  console.log(`${mark} ${name}${detail ? `  \x1b[2m${detail}\x1b[0m` : ''}`);
}

// A tap that the game's pointer handlers actually see.
async function tap(page, x, y, holdMs = 60) {
  await page.touchscreen.tap(x, y).catch(async () => {
    await page.mouse.click(x, y);
  });
  if (holdMs) await page.waitForTimeout(holdMs);
}

async function press(page, x, y, ms) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x, y, radiusX: 12, radiusY: 12, force: 1 }],
  });
  await page.waitForTimeout(ms);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
}

async function main() {
  const { chromium } = loadPlaywright();
  const { server, port } = await serve(ROOT);
  const base = `http://127.0.0.1:${port}/`;
  if (SHOTS) await mkdir(SHOT_DIR, { recursive: true });

  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 }, // iPhone 14-ish portrait
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  });

  const errors = [];
  const page = await context.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

  // ---------------------------------------------------------------- boot
  await page.goto(base, { waitUntil: 'networkidle' });
  await page.waitForTimeout(900);

  const booted = await page.evaluate(() => !!window.__GAME__);
  check('game boots and exposes a debug handle', booted);

  const canvasOk = await page.evaluate(() => {
    const c = document.querySelector('canvas');
    return !!c && c.width > 0 && c.height > 0;
  });
  check('canvas is sized', canvasOk);

  check('no console errors on boot', errors.length === 0, errors.slice(0, 3).join(' | '));

  // ------------------------------------------------------- layout hygiene
  const layout = await page.evaluate(() => ({
    scrollW: document.documentElement.scrollWidth,
    clientW: document.documentElement.clientWidth,
    scrollH: document.documentElement.scrollHeight,
    clientH: document.documentElement.clientHeight,
    overflow: getComputedStyle(document.body).overflow,
    touchAction: getComputedStyle(document.querySelector('canvas') || document.body).touchAction,
  }));
  check(
    'no page scroll (no bounce/pull-to-refresh)',
    layout.scrollW <= layout.clientW + 1 && layout.scrollH <= layout.clientH + 1,
    `${layout.scrollW}x${layout.scrollH} vs ${layout.clientW}x${layout.clientH}`
  );
  check('canvas disables browser touch gestures', layout.touchAction === 'none', `touch-action: ${layout.touchAction}`);

  if (SHOTS) await page.screenshot({ path: join(SHOT_DIR, '01-menu.png') });

  // ------------------------------------------------------------ start run
  await tap(page, 195, 745); // PLAY sits under the thumb, near the bottom
  await page.waitForTimeout(400);
  let state = await page.evaluate(() => window.__GAME__?.state);
  check('tap starts a run', state === 'play' || state === 'intro', `state=${state}`);

  // -------------------------------------------------------- play a while
  // Drive it like a real thumb: alternating holds and taps across the screen.
  for (let i = 0; i < 14; i++) {
    const x = 90 + (i % 5) * 55;
    await press(page, x, 700, 90 + (i % 3) * 70);
    await page.waitForTimeout(120);
  }
  if (SHOTS) await page.screenshot({ path: join(SHOT_DIR, '02-play.png') });

  const mid = await page.evaluate(() => window.__GAME__?.debugSnapshot?.());
  check('run advances (time and score move)', !!mid && mid.runTime > 1, JSON.stringify(mid || {}).slice(0, 160));

  // ------------------------------------------------------- frame budget
  const perf = await page.evaluate(
    () =>
      new Promise((done) => {
        const samples = [];
        let last = performance.now();
        let n = 0;
        function frame(t) {
          samples.push(t - last);
          last = t;
          if (++n < 150) requestAnimationFrame(frame);
          else {
            samples.sort((a, b) => a - b);
            done({
              median: samples[Math.floor(samples.length / 2)],
              p95: samples[Math.floor(samples.length * 0.95)],
              worst: samples[samples.length - 1],
            });
          }
        }
        requestAnimationFrame(frame);
      })
  );
  // Headless Chromium is not a phone, but a blown budget here is a red flag.
  check('frame times are healthy', perf.p95 < 24, `median ${perf.median.toFixed(1)}ms  p95 ${perf.p95.toFixed(1)}ms`);

  // ------------------------------------------------------- forced game over
  const ended = await page.evaluate(async () => {
    window.__GAME__?.debugKill?.();
    await new Promise((r) => setTimeout(r, 2200));
    return window.__GAME__?.state;
  });
  check('run can end and reach a result screen', ended === 'over' || ended === 'summary', `state=${ended}`);
  if (SHOTS) await page.screenshot({ path: join(SHOT_DIR, '03-gameover.png') });

  const persisted = await page.evaluate(() => {
    const raw = localStorage.getItem('flashover.v1');
    return raw ? JSON.parse(raw) : null;
  });
  check('progress persists to localStorage', !!persisted && persisted.runs >= 1, `runs=${persisted?.runs}`);

  // ------------------------------------------------- service worker offline
  const swState = await page.evaluate(async () => {
    if (!('serviceWorker' in navigator)) return 'unsupported';
    const reg = await navigator.serviceWorker.getRegistration();
    if (!reg) return 'unregistered';
    if (reg.active) return 'active';
    await new Promise((r) => setTimeout(r, 1500));
    const again = await navigator.serviceWorker.getRegistration();
    return again?.active ? 'active' : 'installing';
  });
  check('service worker is active', swState === 'active', swState);

  // Reload with the network cut — this is the actual "offline game" claim.
  await context.setOffline(true);
  const offlinePage = await context.newPage();
  const offErrors = [];
  offlinePage.on('pageerror', (e) => offErrors.push(e.message));
  let offlineOk = false;
  try {
    await offlinePage.goto(base, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await offlinePage.waitForTimeout(1200);
    offlineOk = await offlinePage.evaluate(() => !!window.__GAME__ && !!document.querySelector('canvas'));
  } catch (e) {
    offErrors.push(String(e.message).slice(0, 120));
  }
  check('loads and runs with the network offline', offlineOk, offErrors.slice(0, 2).join(' | '));
  if (SHOTS && offlineOk) await offlinePage.screenshot({ path: join(SHOT_DIR, '04-offline.png') });
  await context.setOffline(false);

  // ------------------------------------------------------------- manifest
  const manifest = await page.evaluate(async () => {
    const link = document.querySelector('link[rel=manifest]');
    if (!link) return null;
    const r = await fetch(link.href);
    return r.json();
  });
  const iconsOk =
    !!manifest &&
    Array.isArray(manifest.icons) &&
    manifest.icons.some((i) => String(i.sizes).includes('512')) &&
    manifest.icons.some((i) => String(i.purpose || '').includes('maskable'));
  check('installable manifest with 512px + maskable icons', iconsOk, manifest ? `${manifest.icons?.length} icons` : 'no manifest');

  // ------------------------------------------------- small-screen sanity
  const small = await context.newPage();
  await small.setViewportSize({ width: 320, height: 568 }); // iPhone SE 1st gen
  await small.goto(base, { waitUntil: 'networkidle' });
  await small.waitForTimeout(700);
  const smallOk = await small.evaluate(
    () => !!window.__GAME__ && document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1
  );
  check('works on a 320px-wide screen', smallOk);
  if (SHOTS) await small.screenshot({ path: join(SHOT_DIR, '05-small.png') });

  check('no console errors across the whole session', errors.length === 0, errors.slice(0, 3).join(' | '));

  await browser.close();
  server.close();

  const failed = results.filter((r) => !r.pass);
  await writeFile(join(ROOT, '.playtest-report.json'), JSON.stringify(results, null, 2)).catch(() => {});
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
