// 기본 스티커용 '윙크하는 스마일' GIF 만들기 → public/stickers/wink.gif
//   node scripts/make-wink-gif.mjs
//
// 캔버스 없이 도형 안팎 판정(4×4 슈퍼샘플링)으로 그리고, omggif 로 GIF 를 씀.
// GIF 투명도는 켜고 끄기뿐이라 가장자리 반투명은 흰색 위에 섞음 → 스티커의 흰 칼선 위에서 매끈하게 보임

import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import omggif from 'omggif';

const SIZE = 384; // frames.js 의 MAX_SIDE 와 같게
const CENTER = SIZE / 2;
const SUB = 4; // 한 픽셀을 4×4 로 나눠 판정 (안티앨리어싱)

const YELLOW = [255, 210, 63];
const HIGHLIGHT = [255, 240, 168];
const RIM = [227, 146, 0];
const CHEEK = [255, 150, 140];
const INK = [58, 38, 16];
const WHITE = [255, 255, 255];

// 프레임: 눈 감은 정도(0 뜸 ~ 1 감음), 얼굴 기울기(rad), 입 크기, 볼 진하기, 보여 줄 시간(ms)
const FRAMES = [
  { wink: 0, tilt: 0, smile: 1, blush: 0.55, delay: 1300 },
  { wink: 0.5, tilt: -0.04, smile: 1.02, blush: 0.6, delay: 50 },
  { wink: 1, tilt: -0.09, smile: 1.06, blush: 0.75, delay: 60 },
  { wink: 1, tilt: -0.11, smile: 1.08, blush: 0.8, delay: 380 },
  { wink: 1, tilt: -0.07, smile: 1.05, blush: 0.7, delay: 60 },
  { wink: 0.5, tilt: -0.03, smile: 1.02, blush: 0.6, delay: 50 },
];

const frames = FRAMES.map(render);
const { palette, lookup } = buildPalette(frames);
const buffer = new Uint8Array(SIZE * SIZE * FRAMES.length * 2 + 4096);
const writer = new omggif.GifWriter(buffer, SIZE, SIZE, { palette, loop: 0 });
frames.forEach((pixels, i) => {
  const indices = new Uint8Array(SIZE * SIZE);
  for (let p = 0; p < indices.length; p++) {
    indices[p] = pixels[p * 4 + 3] ? lookup(pixels[p * 4], pixels[p * 4 + 1], pixels[p * 4 + 2]) : 0;
  }
  writer.addFrame(0, 0, SIZE, SIZE, indices, { delay: Math.round(FRAMES[i].delay / 10), transparent: 0, disposal: 2 });
});
const out = fileURLToPath(new URL('../public/stickers/wink.gif', import.meta.url));
await mkdir(fileURLToPath(new URL('../public/stickers/', import.meta.url)), { recursive: true });
await writeFile(out, buffer.subarray(0, writer.end()));
console.log(`wink.gif: ${FRAMES.length} frames, ${palette.length} colors`);

// ── 그리기 ─────────────────────────────────────────

function render(frame) {
  const pixels = new Uint8ClampedArray(SIZE * SIZE * 4);
  const cos = Math.cos(-frame.tilt);
  const sin = Math.sin(-frame.tilt);
  for (let py = 0; py < SIZE; py++) {
    for (let px = 0; px < SIZE; px++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let covered = 0;
      for (let sy = 0; sy < SUB; sy++) {
        for (let sx = 0; sx < SUB; sx++) {
          // 얼굴 중심 기준으로 기울기를 되돌린 좌표 (y 아래)
          const dx = px + (sx + 0.5) / SUB - CENTER;
          const dy = py + (sy + 0.5) / SUB - CENTER;
          const color = shade(dx * cos - dy * sin, dx * sin + dy * cos, frame);
          if (!color) continue;
          r += color[0];
          g += color[1];
          b += color[2];
          covered++;
        }
      }
      if (!covered) continue;
      const alpha = covered / (SUB * SUB);
      const i = (py * SIZE + px) * 4;
      // 가장자리: 흰 바탕에 섞고, 반 넘게 덮였으면 불투명 아니면 투명
      pixels[i] = r / covered * alpha + WHITE[0] * (1 - alpha);
      pixels[i + 1] = g / covered * alpha + WHITE[1] * (1 - alpha);
      pixels[i + 2] = b / covered * alpha + WHITE[2] * (1 - alpha);
      pixels[i + 3] = alpha >= 0.5 ? 255 : 0;
    }
  }
  return pixels;
}

// 한 점의 색. 얼굴 밖이면 null
function shade(x, y, { wink, smile, blush }) {
  const R = 168;
  const d = Math.hypot(x, y);
  if (d > R) return null;
  // 위에서부터 덮이는 순서대로 판정
  if (inArc(x, y, 0, -6, 104 * smile, 11, 0.16 * Math.PI, 0.84 * Math.PI)) return INK; // 입
  if (inEllipse(x, y, -62, -38, 17, 28)) return INK; // 왼눈 (늘 뜸)
  if (wink < 1) {
    if (inEllipse(x, y, 62, -38 + 12 * wink, 17 + 3 * wink, 28 * (1 - wink * 1.4))) return INK; // 오른눈 (반쯤 감으면 납작하게)
  } else if (inArc(x, y, 62, -18, 26, 9, 1.15 * Math.PI, 1.85 * Math.PI)) {
    return INK; // 감은 눈 ∩
  }
  if (d > R - 8) return RIM;
  for (const cx of [-98, 98]) {
    if (inEllipse(x, y, cx, 34, 34, 22)) return mix(YELLOW, CHEEK, blush);
  }
  if (inEllipse(rotX(x + 72, y + 98, 0.55), rotY(x + 72, y + 98, 0.55), 0, 0, 46, 20)) return HIGHLIGHT;
  return YELLOW;
}

function inEllipse(x, y, cx, cy, rx, ry) {
  const u = (x - cx) / rx;
  const v = (y - cy) / ry;
  return u * u + v * v <= 1;
}

// 원호 선 (끝은 둥글게). 각도는 화면 기준 (y 아래, 시계 방향 +)
function inArc(x, y, cx, cy, radius, width, from, to) {
  const dx = x - cx;
  const dy = y - cy;
  const angle = (Math.atan2(dy, dx) + Math.PI * 2) % (Math.PI * 2);
  if (angle >= from && angle <= to && Math.abs(Math.hypot(dx, dy) - radius) <= width) return true;
  for (const a of [from, to]) {
    if (Math.hypot(dx - Math.cos(a) * radius, dy - Math.sin(a) * radius) <= width) return true;
  }
  return false;
}

function rotX(x, y, a) {
  return x * Math.cos(a) + y * Math.sin(a);
}

function rotY(x, y, a) {
  return -x * Math.sin(a) + y * Math.cos(a);
}

function mix(a, b, t) {
  return a.map((v, i) => v + (b[i] - v) * t);
}

// ── 팔레트: 많이 쓰인 색 255개 (0번은 투명) ─────────────

function buildPalette(list) {
  const counts = new Map();
  for (const pixels of list) {
    for (let i = 0; i < pixels.length; i += 4) {
      if (!pixels[i + 3]) continue;
      const key = (pixels[i] << 16) | (pixels[i + 1] << 8) | pixels[i + 2];
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  const colors = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 255).map(([key]) => key);
  const palette = [0x000000, ...colors];
  while (palette.length < 256) palette.push(0x000000); // GIF 팔레트 크기는 2의 거듭제곱
  const cache = new Map();
  const lookup = (r, g, b) => {
    const key = (r << 16) | (g << 8) | b;
    if (cache.has(key)) return cache.get(key);
    let best = 1;
    let bestDistance = Infinity;
    for (let i = 1; i <= colors.length; i++) {
      const c = palette[i];
      const distance = ((c >> 16) - r) ** 2 + (((c >> 8) & 255) - g) ** 2 + ((c & 255) - b) ** 2;
      if (distance < bestDistance) {
        best = i;
        bestDistance = distance;
      }
    }
    cache.set(key, best);
    return best;
  };
  return { palette, lookup };
}
