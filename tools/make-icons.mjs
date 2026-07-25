// Generates the PWA icon set.
//
// The game draws all of its art procedurally, and so do its icons: this script
// renders the same hook-and-rope mark on a Canvas in headless Chromium and writes
// real PNGs. That keeps the repo free of binary art nobody can edit, while
// still giving Android and iOS the raster files their installers require.
//
//   node tools/make-icons.mjs

import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const ROOT = resolve(new URL('..', import.meta.url).pathname);
const OUT = join(ROOT, 'icons');

function loadPlaywright() {
  for (const c of ['playwright', '/opt/node22/lib/node_modules/playwright', '/usr/lib/node_modules/playwright']) {
    try {
      return require_(c);
    } catch {
      /* next */
    }
  }
  throw new Error('Playwright not found (npm i -g playwright)');
}

// `inset` reserves the maskable safe zone: Android may crop an icon to a
// circle, so a maskable icon keeps its mark inside the middle 80%.
function drawIcon(size, inset, bleed) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const x = c.getContext('2d');
  const S = size;

  const bg = x.createLinearGradient(0, 0, 0, S);
  bg.addColorStop(0, '#16203a');
  bg.addColorStop(1, '#080c18');
  if (bleed) {
    x.fillStyle = bg;
    x.fillRect(0, 0, S, S);
  } else {
    const r = S * 0.22;
    x.fillStyle = bg;
    x.beginPath();
    x.moveTo(r, 0);
    x.lineTo(S - r, 0);
    x.quadraticCurveTo(S, 0, S, r);
    x.lineTo(S, S - r);
    x.quadraticCurveTo(S, S, S - r, S);
    x.lineTo(r, S);
    x.quadraticCurveTo(0, S, 0, S - r);
    x.lineTo(0, r);
    x.quadraticCurveTo(0, 0, r, 0);
    x.closePath();
    x.fill();
  }

  const k = (1 - inset * 2) * S;
  const cx = S / 2;
  const cy = S / 2;

  // The shaft: two jagged walls closing toward the bottom.
  x.save();
  x.translate(cx, cy);
  x.fillStyle = '#04060e';
  const gap = k * 0.30;
  x.beginPath();
  x.moveTo(-S, -S);
  x.lineTo(-gap * 1.15, -k * 0.5);
  x.lineTo(-gap * 0.72, 0);
  x.lineTo(-gap * 1.0, k * 0.5);
  x.lineTo(-S, S);
  x.closePath();
  x.fill();
  x.beginPath();
  x.moveTo(S, -S);
  x.lineTo(gap * 1.0, -k * 0.5);
  x.lineTo(gap * 0.70, 0);
  x.lineTo(gap * 1.15, k * 0.5);
  x.lineTo(S, S);
  x.closePath();
  x.fill();

  // Anchor ring, rope, and the diver mid-swing — the whole game in one shape.
  const ax = -gap * 0.55;
  const ay = -k * 0.30;
  const dx = gap * 0.42;
  const dy = k * 0.24;

  x.strokeStyle = '#57e0ff';
  x.lineWidth = Math.max(2, S * 0.030);
  x.lineCap = 'round';
  x.globalAlpha = 0.28;
  x.lineWidth = Math.max(4, S * 0.075);
  x.beginPath();
  x.moveTo(ax, ay);
  x.lineTo(dx, dy);
  x.stroke();
  x.globalAlpha = 1;
  x.lineWidth = Math.max(2, S * 0.028);
  x.beginPath();
  x.moveTo(ax, ay);
  x.lineTo(dx, dy);
  x.stroke();

  x.lineWidth = Math.max(2, S * 0.036);
  x.beginPath();
  x.arc(ax, ay, k * 0.10, 0, Math.PI * 2);
  x.stroke();

  x.save();
  x.translate(dx, dy);
  x.rotate(Math.atan2(dy - ay, dx - ax) + Math.PI / 2);
  x.fillStyle = '#ffffff';
  x.beginPath();
  x.ellipse(0, 0, k * 0.055, k * 0.11, 0, 0, Math.PI * 2);
  x.fill();
  x.restore();
  x.restore();

  return c.toDataURL('image/png');
}

const TARGETS = [
  { file: 'icon-192.png', size: 192, inset: 0.16, bleed: false },
  { file: 'icon-512.png', size: 512, inset: 0.16, bleed: false },
  { file: 'maskable-512.png', size: 512, inset: 0.24, bleed: true },
  { file: 'apple-touch-icon.png', size: 180, inset: 0.14, bleed: true },
  { file: 'favicon-64.png', size: 64, inset: 0.12, bleed: false },
];

const { chromium } = loadPlaywright();
const browser = await chromium.launch();
const page = await browser.newPage();
await page.setContent('<body></body>');
await mkdir(OUT, { recursive: true });

for (const t of TARGETS) {
  const dataUrl = await page.evaluate(
    ({ size, inset, bleed, src }) => new Function('size', 'inset', 'bleed', `return (${src})(size, inset, bleed)`)(size, inset, bleed),
    { size: t.size, inset: t.inset, bleed: t.bleed, src: drawIcon.toString() }
  );
  const buf = Buffer.from(dataUrl.split(',')[1], 'base64');
  await writeFile(join(OUT, t.file), buf);
  console.log(`wrote icons/${t.file}  ${buf.length} bytes`);
}

await browser.close();
