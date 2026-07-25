// Screenshots of every screen, for visual review.
//
//   node tools/shots.mjs        # writes .playtest/*.png
//
// Drives the game through window.__GAME__, flies it to depth with a gap-
// threading autopilot, then freezes the simulation and photographs the SAME
// piece of tube at four speeds — so the only variable between those frames is
// velocity, and every difference is the distortion doing its job.

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

// Flies the run to a given depth inside the page, threading the widest gap of
// each plane so the ship is genuinely mid-tube when the shutter opens.
const FLY_TO = (targetDist) => {
  const g = window.__GAME__.game;
  const run = g.run;
  const STEP = 1 / 120;
  run.god = true; // tools only: survive the trip to the interesting depth
  for (let i = 0; i < 120 * 600 && run.dist < targetDist; i++) {
    // Hold the nearest plane ahead until it is actually crossed; releasing it
    // early drifts the ship off the gap it is still inside.
    let best = null;
    let bestDz = 1e9;
    for (const p of run.track.planes()) {
      const dz = p.z - run.z;
      if (dz > 0 && dz < bestDz) { bestDz = dz; best = p; }
    }
    if (best) {
      const arcs = [];
      const t = run.z / 1000;
      const rot = best.spin * t + best.phase;
      for (const a of best.arcs) arcs.push(a[0] + rot, a[1] + (best.iris || 0));
      let want = run.angle;
      let bestGap = -1;
      for (let k = 0; k < 64; k++) {
        const cand = (k / 64) * Math.PI * 2;
        let gap = Infinity;
        for (let j = 0; j < arcs.length; j += 2) {
          const d = Math.abs(Math.atan2(Math.sin(cand - arcs[j]), Math.cos(cand - arcs[j]))) - arcs[j + 1];
          if (d < gap) gap = d;
        }
        if (gap > bestGap) { bestGap = gap; want = cand; }
      }
      const diff = Math.atan2(Math.sin(want - run.angle), Math.cos(want - run.angle));
      run.angle += Math.max(-0.045, Math.min(0.045, diff));
    }
    run.update(STEP, null);
    run.events.length = 0;
  }
};

// Pins the run at one speed and FREEZES the simulation, so the frame captured
// is exactly the frame set up here. Without the freeze the ship keeps flying
// unattended during the settle before the shutter, clips a plane or two, and
// the "full warp" shot ends up showing the wreck instead.
const POSE = (speed, combo) => {
  const g = window.__GAME__.game;
  g.run.speed = speed;
  g.run.combo = combo;
  g.run.comboT = 2;
  g.loop.freeze(30);
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
  localStorage.setItem('redshift.v1', JSON.stringify({
    v: 1, best: 6180, bestScore: 210000, bestCombo: 26, bestSpeed: 4820, runs: 52,
    totalDist: 190000, shards: 2100,
    upgrades: { grip: 2, lens: 0, intake: 3, hull: 1 },
    dists20: [420, 700, 900, 1400, 1200, 1900, 2400, 2100, 2900, 3300,
      3100, 3800, 4200, 4000, 4600, 5100, 4900, 5500, 5800, 6180],
  }));
});

await page.goto(base, { waitUntil: 'networkidle' });
await page.waitForTimeout(1000);
await page.screenshot({ path: join(OUT, '01-title.png') });

await page.evaluate(() => { window.__GAME__.game.screen = 'ship'; });
await page.waitForTimeout(400);
await page.screenshot({ path: join(OUT, '02-ship.png') });

// The whole pitch of the game: ONE piece of tube, at four speeds. The run is
// flown to depth once and then frozen, so between these four frames nothing
// changes except velocity — every difference you can see is the distortion.
await page.evaluate(
  ({ src, dist }) => {
    const g = window.__GAME__.game;
    g.screen = 'title';
    g.beginRun({ daily: false });
    new Function('targetDist', `return (${src})(targetDist)`)(dist);
  },
  { src: FLY_TO.toString(), dist: 30000 }
);

const POSES = [
  ['03-warp-000.png', 900, 0],
  ['04-warp-040.png', 2620, 8],
  ['05-warp-075.png', 4125, 16],
  ['06-warp-100.png', 5200, 24],
];
for (const [name, speed, combo] of POSES) {
  await page.evaluate(
    ({ src, sp, cb }) => new Function('speed', 'combo', `return (${src})(speed, combo)`)(sp, cb),
    { src: POSE.toString(), sp: speed, cb: combo }
  );
  await page.waitForTimeout(260);
  await page.screenshot({ path: join(OUT, name) });
}

await page.evaluate(() => {
  const g = window.__GAME__.game;
  // Release the pose freeze first — with the simulation still held, the death
  // sequence never advances and this shot is just a copy of the last one.
  g.loop.hitstop = 0;
  g.screen = 'play';
  g.run.god = false;
  g.run.killNow();
});
await page.waitForTimeout(3400); // let the count-up finish before the shutter
await page.screenshot({ path: join(OUT, '07-results.png') });

console.log(`wrote screenshots to ${OUT}`);
await browser.close();
server.close();
