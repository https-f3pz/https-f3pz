// Captures screenshots of every screen for visual review.
//
//   node tools/shots.mjs            # writes .playtest/*.png
//
// Drives the game through window.__GAME__ so it can force a mid-run state
// with real enemies and bullets on screen, rather than photographing an empty
// arena a second after the run starts.

import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const ROOT = resolve(new URL('..', import.meta.url).pathname);
const OUT = join(ROOT, '.playtest');

function loadPlaywright() {
  for (const c of ['playwright', '/opt/node22/lib/node_modules/playwright', '/usr/lib/node_modules/playwright']) {
    try {
      return require_(c);
    } catch {
      /* next */
    }
  }
  throw new Error('Playwright not found');
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.webmanifest': 'application/manifest+json',
  '.png': 'image/png', '.json': 'application/json',
};

function serve(root) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    let p = decodeURIComponent(url.pathname);
    if (p.endsWith('/')) p += 'index.html';
    const file = join(root, normalize(p).replace(/^(\.\.[/\\])+/, ''));
    if (!file.startsWith(root) || !existsSync(file)) {
      res.writeHead(404);
      res.end('nope');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(await readFile(file));
  });
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok({ server, port: server.address().port })));
}

const { chromium } = loadPlaywright();
const { server, port } = await serve(ROOT);
const base = `http://127.0.0.1:${port}/`;
await mkdir(OUT, { recursive: true });

const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
});
const page = await ctx.newPage();
page.on('pageerror', (e) => console.error('PAGE ERROR:', e.message));
page.on('console', (m) => m.type() === 'error' && console.error('CONSOLE:', m.text()));

// Seed a save BEFORE any page script runs. Setting it after load and then
// reloading does not work: the game persists on pagehide, so its own (empty)
// save overwrites the seed on the way out.
await ctx.addInitScript(() => {
  localStorage.setItem('flashover.v1', JSON.stringify({
    v: 1, best: 148200, bestTime: 132, runs: 37, totalFlashovers: 61,
    timeAboveHeat50: 1840,
    scores20: [3200, 8100, 12000, 9000, 22000, 31000, 28000, 44000, 51000, 39000,
      62000, 71000, 68000, 90000, 84000, 101000, 96000, 118000, 132000, 148200],
    cores: { needle: { best: 148200, bestTime: 132, bestPressure: 3 }, ember: { best: 0 }, bulwark: { best: 0 } },
    core: 'needle', pressure: 2, unlockedCores: ['needle', 'ember', 'bulwark'],
    marks: { furnace: true, redline: true, ironclad: true },
  }));
});

await page.goto(base, { waitUntil: 'networkidle' });
await page.waitForTimeout(1000);
await page.screenshot({ path: join(OUT, '01-title.png') });

await page.evaluate(() => window.__GAME__.game.screen = 'settings');
await page.waitForTimeout(400);
await page.screenshot({ path: join(OUT, '02-settings.png') });

// Start a run and fast-forward the simulation so the screen is actually full.
await page.evaluate(async () => {
  const g = window.__GAME__.game;
  g.screen = 'title';
  g.beginRun({ daily: false });
  g.draftIndex = 4; // no draft interrupting this capture
  const run = g.run;
  // Drive the simulation forward directly, steering the ship along a lazy
  // orbit so it grazes and builds heat.
  const STEP = 1 / 120;
  for (let i = 0; i < 120 * 40; i++) {
    run.iframes = 9e9; // screenshots need a live ship, not a corpse
    const t = run.time;
    const tx = 180 + Math.sin(t * 1.1) * 90;
    const ty = run.shipMaxY - 40 + Math.cos(t * 0.8) * 60;
    run.anchorTouch = { x: 0, y: 0 };
    run.anchorShip = { x: run.x, y: run.y };
    run.update(STEP, { x: (tx - run.x) / 1.55, y: (ty - run.y) / 1.55 });
    run.events.length = 0;
    if (run.dead) break;
  }
  run.heat = 92;
  run.iframes = 9e9;
  run.displayScore = run.score;
});
await page.waitForTimeout(500);
await page.screenshot({ path: join(OUT, '03-play.png') });

// Ignition.
await page.evaluate(() => {
  const run = window.__GAME__.game.run;
  run.heat = run.s.flashAt;
  run.flashLock = 0;
});
await page.waitForTimeout(450);
await page.screenshot({ path: join(OUT, '04-flashover.png') });

// Draft.
await page.evaluate(() => { window.__GAME__.game.draftIndex = 0; window.__GAME__.game.openDraft(); });
await page.waitForTimeout(500);
await page.screenshot({ path: join(OUT, '05-draft.png') });

// Results.
await page.evaluate(async () => {
  const g = window.__GAME__.game;
  g.screen = 'play';
  g.run.killNow();
});
await page.waitForTimeout(2600);
await page.screenshot({ path: join(OUT, '06-results.png') });

// High contrast, to prove the accessibility mode is actually playable.
await page.evaluate(() => {
  const g = window.__GAME__.game;
  g.save.settings.highContrast = true;
  g.applySettings();
  g.beginRun({ daily: false });
  g.draftIndex = 4;
  const run = g.run;
  const STEP = 1 / 120;
  for (let i = 0; i < 120 * 35; i++) {
    run.iframes = 9e9;
    const t = run.time;
    const tx = 180 + Math.sin(t * 1.1) * 90;
    const ty = run.shipMaxY - 40 + Math.cos(t * 0.8) * 60;
    run.anchorTouch = { x: 0, y: 0 };
    run.anchorShip = { x: run.x, y: run.y };
    run.update(STEP, { x: (tx - run.x) / 1.55, y: (ty - run.y) / 1.55 });
    run.events.length = 0;
    if (run.dead) break;
  }
});
await page.waitForTimeout(500);
await page.screenshot({ path: join(OUT, '07-high-contrast.png') });

console.log(`wrote screenshots to ${OUT}`);
await browser.close();
server.close();
