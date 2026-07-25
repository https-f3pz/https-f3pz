// Generates the PWA icon set.
//
// The game draws all of its art procedurally, and so do its icons: this script
// renders the same tunnel mark on a Canvas in headless Chromium and writes
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

  const bg = x.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S * 0.7);
  bg.addColorStop(0, '#12305c');
  bg.addColorStop(1, '#04060e');
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

  // Receding octagonal rings: the tunnel, in one glance.
  x.save();
  x.translate(cx, cy);
  for (let i = 4; i >= 0; i--) {
    const f = Math.pow((i + 1) / 5, 1.9);
    const rr = k * 0.52 * f;
    x.strokeStyle = `rgba(87,224,255,${(0.25 + (1 - f) * 0.75).toFixed(3)})`;
    x.lineWidth = Math.max(1.5, S * 0.020 * (1 - f * 0.5));
    x.beginPath();
    for (let j = 0; j <= 8; j++) {
      const a = (j / 8) * Math.PI * 2 + Math.PI / 8;
      const px = Math.cos(a) * rr;
      const py = Math.sin(a) * rr;
      if (j === 0) x.moveTo(px, py);
      else x.lineTo(px, py);
    }
    x.closePath();
    x.stroke();
  }

  // The blocked sector — the thing you have to roll away from.
  x.fillStyle = 'rgba(255,59,107,0.92)';
  x.beginPath();
  const a0 = -Math.PI / 2 - 0.42;
  const a1 = -Math.PI / 2 + 0.42;
  x.arc(0, 0, k * 0.52, a0, a1);
  x.arc(0, 0, k * 0.24, a1, a0, true);
  x.closePath();
  x.fill();

  // The ship, at the bottom of the bore.
  x.fillStyle = '#ffffff';
  x.beginPath();
  x.moveTo(0, k * 0.30);
  x.lineTo(k * 0.10, k * 0.47);
  x.lineTo(0, k * 0.41);
  x.lineTo(-k * 0.10, k * 0.47);
  x.closePath();
  x.fill();
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
