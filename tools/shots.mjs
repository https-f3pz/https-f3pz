// Screenshots of every screen, for visual review.
//
//   node tools/shots.mjs        # writes .playtest/*.png
//
// Drives the game through window.__GAME__ and flies it with a simple
// hook-swing-release autopilot, so the mid-dive shots show a real rope under
// real tension rather than a diver in freefall.

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

// Flies the dive forward for `seconds`, hooking and releasing on a rhythm.
// Runs inside the page so it drives the real simulation.
const AUTOPILOT = (seconds, invincible) => {
  const g = window.__GAME__.game;
  const run = g.run;
  const STEP = 1 / 120;
  let hookT = 0;
  for (let i = 0; i < 120 * seconds; i++) {
    if (invincible) {
      // Survive for the photo without deleting the hazards — they are most of
      // what the screenshot is meant to show.
      run.god = true;
      run.collapseY = Math.min(run.collapseY, run.y - 1500);
    }
    hookT += STEP;
    if (run.hook === 0 && hookT > 0.55) {
      run.selectTarget(run.x);
      if (run.target) {
        run.fire(run.x);
        hookT = 0;
      }
    } else if (run.hook === 2 && hookT > 0.42) {
      run.release();
      hookT = 0;
    }
    run.update(STEP, null);
    run.updateTrail(STEP);
    run.events.length = 0;
    if (run.dead) break;
  }
  run.selectTarget(run.x);
  run.predictArc();
};

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

// Seeded before any page script runs — the game persists on pagehide, so
// setting it after load and reloading would be overwritten on the way out.
await ctx.addInitScript(() => {
  localStorage.setItem('hookfall.v1', JSON.stringify({
    v: 1, best: 6420, bestScore: 184000, bestCombo: 27, runs: 48,
    totalDepth: 96000, gems: 210, shards: 2400,
    upgrades: { reach: 2, snap: 1, winch: 3, wax: 1 },
    depths20: [220, 480, 610, 900, 1250, 1180, 1700, 2100, 1950, 2600,
      3100, 2900, 3600, 4200, 3900, 4800, 5200, 5000, 5900, 6420],
  }));
});

await page.goto(base, { waitUntil: 'networkidle' });
await page.waitForTimeout(1000);
await page.screenshot({ path: join(OUT, '01-title.png') });

await page.evaluate(() => { window.__GAME__.game.screen = 'hook'; });
await page.waitForTimeout(400);
await page.screenshot({ path: join(OUT, '02-hook.png') });

await page.evaluate(() => { window.__GAME__.game.screen = 'settings'; });
await page.waitForTimeout(400);
await page.screenshot({ path: join(OUT, '03-settings.png') });

// Runs a fresh dive forward with the autopilot, then screenshots it.
async function shotDive(name, seconds, tweak = null) {
  await page.evaluate(
    ({ secs, src, tw }) => {
      const g = window.__GAME__.game;
      g.screen = 'title';
      g.beginRun({ daily: false });
      if (tw) new Function('run', tw)(g.run);
      new Function('seconds', 'invincible', `return (${src})(seconds, invincible)`)(secs, true);
    },
    { secs: seconds, src: AUTOPILOT.toString(), tw: tweak }
  );
  await page.waitForTimeout(420);
  await page.screenshot({ path: join(OUT, name) });
}

// Early dive: THE MOUTH, rope under tension.
await shotDive('04-dive-mouth.png', 9);

// Deep dive: start the diver already inside a later biome so the palette,
// hazards and speed all reflect a real run rather than the first nine seconds.
await shotDive('05-dive-vein.png', 7, 'run.y = 2900 * 20; run.vy = 1900; run.collapseY = run.y - 1500; run.world.ensure(run.y - 1600, run.y + 3600);');
await shotDive('06-dive-hum.png', 7, 'run.y = 8200 * 20; run.vy = 2300; run.collapseY = run.y - 1200; run.world.ensure(run.y - 1600, run.y + 3600);');

// A chain running, for the HUD.
await shotDive('07-chain.png', 6, 'run.y = 5200 * 20; run.vy = 2100; run.combo = 18; run.comboT = 2.4; run.collapseY = run.y - 900; run.world.ensure(run.y - 1600, run.y + 3600);');

// Results.
await page.evaluate(() => {
  const g = window.__GAME__.game;
  g.screen = 'play';
  g.run.killNow();
});
await page.waitForTimeout(2200);
await page.screenshot({ path: join(OUT, '08-results.png') });

console.log(`wrote screenshots to ${OUT}`);
await browser.close();
server.close();
