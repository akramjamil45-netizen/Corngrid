#!/usr/bin/env node
/**
 * Generates CornGrid Android launcher + splash assets from the existing PWA logo
 * (public/images/pwa-512.png). Idempotent — safe to re-run at any time:
 *
 *   npm run gen:android-assets
 *
 * Outputs (inside android/app/src/main/res):
 *   - mipmap density dirs: ic_launcher.png (rounded square),
 *     ic_launcher_round.png (circle), ic_launcher_foreground.png (adaptive, gold)
 *   - drawable-port, drawable-land and drawable dirs: splash.png
 *     (dark background with a rounded logo tile centered at 42% of the shorter
 *     side), keeping each existing file's exact pixel dimensions.
 */
import { PNG } from 'pngjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'public', 'images', 'pwa-512.png');
const RES = path.join(ROOT, 'android', 'app', 'src', 'main', 'res');

const GOLD = [255, 212, 0, 255];
const DARK = [8, 10, 15, 255];

const logo = PNG.sync.read(fs.readFileSync(SRC));

/** Box-filter resize — high quality for the down-scales used here. */
function resize(src, dw, dh) {
  const sw = src.width;
  const sh = src.height;
  const dst = { width: dw, height: dh, data: Buffer.alloc(dw * dh * 4) };
  for (let y = 0; y < dh; y++) {
    const sy0 = Math.floor((y * sh) / dh);
    const sy1 = Math.max(sy0 + 1, Math.floor(((y + 1) * sh) / dh));
    for (let x = 0; x < dw; x++) {
      const sx0 = Math.floor((x * sw) / dw);
      const sx1 = Math.max(sx0 + 1, Math.floor(((x + 1) * sw) / dw));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let sy = sy0; sy < sy1 && sy < sh; sy++) {
        for (let sx = sx0; sx < sx1 && sx < sw; sx++) {
          const i = (sy * sw + sx) * 4;
          r += src.data[i];
          g += src.data[i + 1];
          b += src.data[i + 2];
          a += src.data[i + 3];
          n++;
        }
      }
      const di = (y * dw + x) * 4;
      dst.data[di] = Math.round(r / n);
      dst.data[di + 1] = Math.round(g / n);
      dst.data[di + 2] = Math.round(b / n);
      dst.data[di + 3] = Math.round(a / n);
    }
  }
  return dst;
}

function makeCanvas(w, h, rgba) {
  const png = new PNG({ width: w, height: h });
  for (let i = 0; i < w * h; i++) {
    png.data[i * 4] = rgba[0];
    png.data[i * 4 + 1] = rgba[1];
    png.data[i * 4 + 2] = rgba[2];
    png.data[i * 4 + 3] = rgba[3];
  }
  return png;
}

/** Draws img centered onto dst with source-over blending. */
function stamp(dst, img) {
  const ox = Math.round((dst.width - img.width) / 2);
  const oy = Math.round((dst.height - img.height) / 2);
  for (let y = 0; y < img.height; y++) {
    const py = y + oy;
    if (py < 0 || py >= dst.height) continue;
    for (let x = 0; x < img.width; x++) {
      const px = x + ox;
      if (px < 0 || px >= dst.width) continue;
      const si = (y * img.width + x) * 4;
      const di = (py * dst.width + px) * 4;
      const sa = img.data[si + 3] / 255;
      if (sa <= 0) continue;
      dst.data[di] = Math.round(img.data[si] * sa + dst.data[di] * (1 - sa));
      dst.data[di + 1] = Math.round(img.data[si + 1] * sa + dst.data[di + 1] * (1 - sa));
      dst.data[di + 2] = Math.round(img.data[si + 2] * sa + dst.data[di + 2] * (1 - sa));
      dst.data[di + 3] = Math.round((sa + (dst.data[di + 3] / 255) * (1 - sa)) * 255);
    }
  }
}

/** Applies a 'round' (rounded square) or 'circle' alpha mask to the whole canvas. */
function maskCanvas(png, shape, frac = 0.18) {
  const { width: w, height: h, data } = png;
  const radius = shape === 'circle' ? Math.min(w, h) / 2 : Math.min(w, h) * frac;
  const cx = w / 2;
  const cy = h / 2;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = x - cx + 0.5;
      const dy = y - cy + 0.5;
      let inside;
      if (shape === 'circle') {
        inside = Math.hypot(dx, dy) <= radius;
      } else {
        const rx = Math.max(Math.abs(dx) - (cx - radius), 0);
        const ry = Math.max(Math.abs(dy) - (cy - radius), 0);
        inside = Math.hypot(rx, ry) <= radius;
      }
      if (!inside) data[(y * w + x) * 4 + 3] = 0;
    }
  }
}

function writePng(png, file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, PNG.sync.write(png));
  console.log('wrote', path.relative(ROOT, file));
}
// --- Legacy launcher icons (pre-API 26 renders and store tools) -----------------
const legacy = {
  'mipmap-mdpi': 48,
  'mipmap-hdpi': 72,
  'mipmap-xhdpi': 96,
  'mipmap-xxhdpi': 144,
  'mipmap-xxxhdpi': 192,
};
for (const [dir, size] of Object.entries(legacy)) {
  const img = resize(logo, size, size);
  const square = makeCanvas(size, size, [0, 0, 0, 0]);
  stamp(square, img);
  maskCanvas(square, 'round');
  writePng(square, path.join(RES, dir, 'ic_launcher.png'));
  const round = makeCanvas(size, size, [0, 0, 0, 0]);
  stamp(round, img);
  maskCanvas(round, 'circle');
  writePng(round, path.join(RES, dir, 'ic_launcher_round.png'));
}

// --- Adaptive icon foreground (108dp canvas; logo at 66% stays in safe zone) ---
const adaptive = {
  'mipmap-mdpi': 108,
  'mipmap-hdpi': 162,
  'mipmap-xhdpi': 216,
  'mipmap-xxhdpi': 324,
  'mipmap-xxxhdpi': 432,
};
for (const [dir, size] of Object.entries(adaptive)) {
  const canvas = makeCanvas(size, size, GOLD);
  stamp(canvas, resize(logo, Math.round(size * 0.66), Math.round(size * 0.66)));
  writePng(canvas, path.join(RES, dir, 'ic_launcher_foreground.png'));
}

// --- Splash screens: keep existing dimensions, dark bg + centered logo tile ----
const splashFiles = [];
for (const prefix of ['drawable-port', 'drawable-land']) {
  for (const dpi of ['mdpi', 'hdpi', 'xhdpi', 'xxhdpi', 'xxxhdpi']) {
    const f = path.join(RES, `${prefix}-${dpi}`, 'splash.png');
    if (fs.existsSync(f)) splashFiles.push(f);
  }
}
const plainSplash = path.join(RES, 'drawable', 'splash.png');
if (fs.existsSync(plainSplash)) splashFiles.push(plainSplash);

for (const file of splashFiles) {
  const existing = PNG.sync.read(fs.readFileSync(file));
  const canvas = makeCanvas(existing.width, existing.height, DARK);
  const tilePx = Math.round(Math.min(existing.width, existing.height) * 0.42);
  const tile = makeCanvas(tilePx, tilePx, [0, 0, 0, 0]);
  stamp(tile, resize(logo, tilePx, tilePx));
  maskCanvas(tile, 'round', 0.16);
  stamp(canvas, tile);
  writePng(canvas, file);
}

console.log(`Done: ${splashFiles.length} splash images + launcher icon set.`);