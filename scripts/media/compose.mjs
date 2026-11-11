// 商店页素材：把面板帧和页面帧逐帧拼成动图，可选导出一张静态截图。
// 用法：node scripts/media/compose.mjs <storyboard.json>
//
// storyboard 里的路径相对于 storyboard 文件所在目录，坐标和尺寸都是 CSS 像素：
// {
//   "scale": 2,                                  输入截图的像素密度；动图缩到 1x，静态图保持原样
//   "panelWidth": 320, "pageWidth": 880, "height": 720,
//   "gif": "out/hero.gif",
//   "still": { "frame": 12, "out": "out/overview.png" },   可选：用第几帧导出静态图，不画指针
//   "frames": [{
//     "panel": { "file": "panel/row1.png", "x": 320, "y": 0 },   从截图里裁出面板
//     "page": "page/p01.png",                                    页面截图，从左上角取
//     "cursor": { "on": "page", "x": 440, "y": 326, "kind": "arrow" },   可选；kind 是 arrow 或 ew
//     "delay": 1200                                              停留毫秒
//   }]
// }
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import pngjs from 'pngjs';
import gifenc from 'gifenc';

const { PNG } = pngjs;
const { GIFEncoder, quantize } = gifenc;

const boardFile = resolve(process.argv[2] ?? '');
const board = JSON.parse(readFileSync(boardFile, 'utf8'));
const at = (p) => resolve(dirname(boardFile), p);
const S = board.scale ?? 2;
const PANEL_W = board.panelWidth ?? 320;
const PAGE_W = board.pageWidth ?? 880;
const H = board.height ?? 720;
const GAP = 1;
const W = PANEL_W + GAP + PAGE_W;
const DIVIDER = [42, 42, 42];

const cache = new Map();
const readPng = (file) => {
  if (!cache.has(file)) cache.set(file, PNG.sync.read(readFileSync(at(file))));
  return cache.get(file);
};

function canvas(w, h, rgb = [0, 0, 0]) {
  const data = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) data.set([rgb[0], rgb[1], rgb[2], 255], i * 4);
  return { width: w, height: h, data };
}

function blit(dst, src, sx, sy, sw, sh, dx, dy) {
  for (let y = 0; y < sh; y++) {
    const from = ((sy + y) * src.width + sx) * 4;
    src.data.copy(dst.data, ((dy + y) * dst.width + dx) * 4, from, from + sw * 4);
  }
}

/** 按 S×S 的块取平均缩到 1x */
function downscale(src) {
  const w = src.width / S;
  const h = src.height / S;
  const out = canvas(w, h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      for (let c = 0; c < 4; c++) {
        let sum = 0;
        for (let dy = 0; dy < S; dy++) for (let dx = 0; dx < S; dx++) sum += src.data[((y * S + dy) * src.width + x * S + dx) * 4 + c];
        out.data[(y * w + x) * 4 + c] = Math.round(sum / (S * S));
      }
  return out;
}

/* 指针：多边形填黑、外圈 1px 白边，4×4 超采样抗锯齿；arrow 的尖端、ew 的中心落在指定坐标 */
const SHAPES = {
  arrow: [[0, 0], [0, 16], [4, 12.5], [6.8, 19], [9.2, 18], [6.5, 11.6], [11.5, 11.6]],
  ew: [[-9, 0], [-4.5, -4.5], [-4.5, -1.6], [4.5, -1.6], [4.5, -4.5], [9, 0], [4.5, 4.5], [4.5, 1.6], [-4.5, 1.6], [-4.5, 4.5]],
};

function inside(poly, x, y) {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

function drawCursor(img, kind, px, py) {
  const poly = SHAPES[kind] ?? SHAPES.arrow;
  const ring = 1.2;
  const dirs = Array.from({ length: 16 }, (_, a) => [Math.cos((a / 8) * Math.PI) * ring, Math.sin((a / 8) * Math.PI) * ring]);
  const xs = poly.map((p) => p[0]);
  const ys = poly.map((p) => p[1]);
  const SS = 4;
  for (let y = Math.floor(Math.min(...ys) - 3); y <= Math.ceil(Math.max(...ys) + 3); y++)
    for (let x = Math.floor(Math.min(...xs) - 3); x <= Math.ceil(Math.max(...xs) + 3); x++) {
      let black = 0;
      let white = 0;
      for (let sy = 0; sy < SS; sy++)
        for (let sx = 0; sx < SS; sx++) {
          const fx = x + (sx + 0.5) / SS;
          const fy = y + (sy + 0.5) / SS;
          if (inside(poly, fx, fy)) black++;
          else if (dirs.some(([dx, dy]) => inside(poly, fx - dx, fy - dy))) white++;
        }
      const ix = Math.round(px) + x;
      const iy = Math.round(py) + y;
      if (!(black + white) || ix < 0 || iy < 0 || ix >= img.width || iy >= img.height) continue;
      const o = (iy * img.width + ix) * 4;
      const a = (black + white) / (SS * SS);
      const v = (white * 255) / (black + white);
      for (let c = 0; c < 3; c++) img.data[o + c] = Math.round(img.data[o + c] * (1 - a) + v * a);
    }
}

/** 原始像素密度的合成：左边面板、分隔线、右边页面 */
function compose(frame) {
  const img = canvas(W * S, H * S, DIVIDER);
  const panel = readPng(frame.panel.file);
  blit(img, panel, frame.panel.x * S, frame.panel.y * S, PANEL_W * S, H * S, 0, 0);
  blit(img, readPng(frame.page), 0, 0, PAGE_W * S, H * S, (PANEL_W + GAP) * S, 0);
  return img;
}

const write = (file, bytes) => {
  mkdirSync(dirname(at(file)), { recursive: true });
  writeFileSync(at(file), bytes);
};

if (board.still) write(board.still.out, PNG.sync.write(compose(board.frames[board.still.frame])));

const frames = board.frames.map((f) => {
  const img = downscale(compose(f));
  if (f.cursor) drawCursor(img, f.cursor.kind, f.cursor.x + (f.cursor.on === 'page' ? PANEL_W + GAP : 0), f.cursor.y);
  return { img, delay: f.delay ?? 500 };
});

// 所有帧共用一张调色板（隔点取样）；最后一个索引留作透明，和上一帧相同的像素都写成透明，文件小很多
const samples = [];
for (const { img } of frames) for (let i = 0; i < img.data.length; i += 8) samples.push(img.data[i], img.data[i + 1], img.data[i + 2], 255);
const palette = quantize(Uint8Array.from(samples), 255, { format: 'rgb565' });
while (palette.length < 255) palette.push([0, 0, 0]);
const opaque = palette.slice();
const TRANSPARENT = palette.push([255, 0, 255]) - 1;

/**
 * 每种颜色各自找最近的调色板色，所有帧共用一份对照。
 * gifenc 的 applyPalette 按 rgb565 分箱缓存：同一箱里先遇到哪个颜色，整箱都跟它走，
 * 纯白会跟着旁边的近白色变灰，而且每帧先遇到的不一样，同一块白底在帧之间会跳色
 */
const nearest = new Map();
function toIndex(data) {
  const index = new Uint8Array(data.length / 4);
  for (let i = 0; i < index.length; i++) {
    const r = data[i * 4];
    const g = data[i * 4 + 1];
    const b = data[i * 4 + 2];
    const key = (r << 16) | (g << 8) | b;
    let at = nearest.get(key);
    if (at === undefined) {
      let best = Infinity;
      at = 0;
      for (let k = 0; k < opaque.length; k++) {
        const d = (r - opaque[k][0]) ** 2 + (g - opaque[k][1]) ** 2 + (b - opaque[k][2]) ** 2;
        if (d < best) {
          best = d;
          at = k;
        }
      }
      nearest.set(key, at);
    }
    index[i] = at;
  }
  return index;
}

const gif = GIFEncoder();
let prev = null;
frames.forEach(({ img, delay }, k) => {
  const index = toIndex(img.data);
  const shown = index.slice();
  if (prev) for (let i = 0; i < index.length; i++) if (index[i] === prev[i]) index[i] = TRANSPARENT;
  gif.writeFrame(index, W, H, { ...(k === 0 ? { palette } : {}), delay, transparent: true, transparentIndex: TRANSPARENT, dispose: 1 });
  prev = shown;
});
gif.finish();
write(board.gif, gif.bytes());
console.log(`${board.gif}: ${frames.length} frames, ${gif.bytes().length} bytes`);
