// Generates the PWA icon set.
//
// The game draws all of its art procedurally, and so do its icons: this script
// renders the same vessel mark on a Canvas in headless Chromium and writes
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

  if (bleed) {
    // Maskable icons must fill the full square — no transparent corners.
    const bg = x.createLinearGradient(0, 0, S, S);
    bg.addColorStop(0, '#100a2c');
    bg.addColorStop(1, '#05040d');
    x.fillStyle = bg;
    x.fillRect(0, 0, S, S);
  } else {
    const r = S * 0.22;
    const bg = x.createLinearGradient(0, 0, S, S);
    bg.addColorStop(0, '#151038');
    bg.addColorStop(1, '#05040d');
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

  // Glow behind the mark.
  const glow = x.createRadialGradient(S / 2, S * 0.5, 0, S / 2, S * 0.5, S * 0.5);
  glow.addColorStop(0, 'rgba(109,242,255,0.42)');
  glow.addColorStop(0.55, 'rgba(178,107,255,0.16)');
  glow.addColorStop(1, 'rgba(0,0,0,0)');
  x.fillStyle = glow;
  x.fillRect(0, 0, S, S);

  const k = (1 - inset * 2) * S;
  const cx = S / 2;
  const cy = S / 2;
  const w = k * 0.34;
  const h = k * 0.46;

  // The crystal: the player's vessel, same silhouette the game draws.
  x.save();
  x.translate(cx, cy);
  const face = x.createLinearGradient(-w, -h, w, h);
  face.addColorStop(0, '#8ef6ff');
  face.addColorStop(0.45, '#b26bff');
  face.addColorStop(1, '#ff5fa8');
  x.fillStyle = face;
  x.beginPath();
  x.moveTo(0, -h);
  x.lineTo(w, -h * 0.18);
  x.lineTo(w * 0.56, h);
  x.lineTo(-w * 0.56, h);
  x.lineTo(-w, -h * 0.18);
  x.closePath();
  x.fill();

  // Inner facet lines give it depth at 48px as well as 512px.
  x.strokeStyle = 'rgba(255,255,255,0.55)';
  x.lineWidth = Math.max(1, S * 0.012);
  x.lineJoin = 'round';
  x.beginPath();
  x.moveTo(0, -h);
  x.lineTo(0, h);
  x.moveTo(-w, -h * 0.18);
  x.lineTo(w, -h * 0.18);
  x.stroke();

  x.strokeStyle = 'rgba(255,255,255,0.9)';
  x.lineWidth = Math.max(1, S * 0.016);
  x.beginPath();
  x.moveTo(0, -h);
  x.lineTo(w, -h * 0.18);
  x.lineTo(w * 0.56, h);
  x.lineTo(-w * 0.56, h);
  x.lineTo(-w, -h * 0.18);
  x.closePath();
  x.stroke();
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
