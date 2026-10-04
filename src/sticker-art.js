// 이미지(PNG, GIF 프레임들 등) → 다이컷 스티커 텍스처.
// 투명한 바깥은 잘라 내고, 실루엣을 따라 흰 테두리를 두르고, 그림자와 클릭 판정용 마스크를 만든다.
// 움직이는 이미지는 모든 프레임을 겹친 실루엣으로 칼선을 한 번만 만들고, 프레임마다 그 위에 다시 그린다.

const TEX = 512; // 텍스처 긴 변
const BORDER = 28; // 흰 테두리 두께 (텍스처 px)
const SHADOW = 9; // 그림자 번짐 (텍스처 px)
const PAD = BORDER + SHADOW * 3 + 2; // 테두리와 그림자가 들어갈 여백

// 실루엣을 흐린 값에서 이 문턱으로 자르면 테두리가 약 BORDER px 두께가 됨 (흐림 σ ≈ BORDER/2 일 때 2σ 지점)
const EDGE = 0.027;
const AA = 0.004; // 외곽선 안티앨리어싱 폭 (≈ ±1px)

/**
 * frames: drawImage 로 그릴 수 있는 것(ImageBitmap, canvas)들. 정지 이미지는 한 장, 움직이는 이미지는 같은 크기 여러 장
 * → { canvas: 스티커 RGBA, compose(frame): canvas 를 그 프레임으로 다시 그림, shadow: 그림자 알파,
 *     mask: 판정용 알파(0~255), width, height, bounds: 스티커 영역(px) }
 */
export function cutSticker(frames) {
  const first = frames[0];

  // 1. 모든 프레임을 겹친 모양에서 투명한 여백 잘라 내기 (너무 큰 원본은 1024 로 줄여서 봄)
  const pre = Math.min(1, 1024 / Math.max(first.width, first.height));
  const tw = Math.max(1, Math.round(first.width * pre));
  const th = Math.max(1, Math.round(first.height * pre));
  const trim = canvasOf(tw, th);
  const tctx = trim.getContext('2d', { willReadFrequently: true });
  const seen = new Uint8ClampedArray(tw * th);
  for (const frame of frames) {
    tctx.clearRect(0, 0, tw, th);
    tctx.drawImage(frame, 0, 0, tw, th);
    const data = tctx.getImageData(0, 0, tw, th).data;
    for (let i = 0; i < seen.length; i++) if (data[i * 4 + 3] > seen[i]) seen[i] = data[i * 4 + 3];
  }
  const box = alphaBox(seen, tw, th) ?? { x: 0, y: 0, w: tw, h: th };
  const src = { x: box.x / pre, y: box.y / pre, w: box.w / pre, h: box.h / pre }; // 원본 좌표

  // 2. 여백을 두고 텍스처에 맞춰 배치
  const fit = (TEX - PAD * 2) / Math.max(src.w, src.h);
  const w = Math.max(1, Math.round(src.w * fit));
  const h = Math.max(1, Math.round(src.h * fit));
  const W = w + PAD * 2;
  const H = h + PAD * 2;
  const n = W * H;
  const art = canvasOf(W, H);
  const actx = art.getContext('2d', { willReadFrequently: true });
  actx.imageSmoothingQuality = 'high';

  // 3. 실루엣 = 모든 프레임 중 가장 진한 알파. 옅은 반투명(그림자·번짐)까지 테두리를 키우지 않게 문턱으로 정리
  const alpha = new Float32Array(n);
  for (const frame of frames) {
    actx.clearRect(0, 0, W, H);
    actx.drawImage(frame, src.x, src.y, src.w, src.h, PAD, PAD, w, h);
    const data = actx.getImageData(0, 0, W, H).data;
    for (let i = 0; i < n; i++) {
      const a = data[i * 4 + 3] / 255;
      if (a > alpha[i]) alpha[i] = a;
    }
  }
  const solid = new Float32Array(n);
  for (let i = 0; i < n; i++) solid[i] = smoothstep(0.2, 0.6, alpha[i]);

  // 4. 흐린 뒤 낮은 문턱으로 자르면 둥글게 부푼 칼선이 됨. 좁은 틈과 작은 구멍은 메워져서 진짜 다이컷처럼
  const field = blur(solid, W, H, BORDER / 2);
  const outline = new Float32Array(n);
  let minX = W;
  let minY = H;
  let maxX = 0;
  let maxY = 0;
  for (let i = 0; i < n; i++) {
    const a = Math.max(smoothstep(EDGE - AA, EDGE + AA, field[i]), solid[i]);
    outline[i] = a;
    if (a > 0.5) {
      const x = i % W;
      const y = (i / W) | 0;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }

  // 5. 흰 테두리 위에 원본. 칼선 밖으로 나간 옅은 그림자 같은 건 잘려 나감 (source-atop)
  const border = canvasOf(W, H);
  const bctx = border.getContext('2d');
  const white = bctx.createImageData(W, H);
  for (let i = 0; i < n; i++) {
    const j = i * 4;
    white.data[j] = 255;
    white.data[j + 1] = 255;
    white.data[j + 2] = 255;
    white.data[j + 3] = outline[i] * 255;
  }
  bctx.putImageData(white, 0, 0);
  const out = canvasOf(W, H);
  const octx = out.getContext('2d');
  octx.imageSmoothingQuality = 'high';
  const compose = (frame) => {
    octx.globalCompositeOperation = 'copy';
    octx.drawImage(border, 0, 0);
    octx.globalCompositeOperation = 'source-atop';
    octx.drawImage(frame, src.x, src.y, src.w, src.h, PAD, PAD, w, h);
    octx.globalCompositeOperation = 'source-over';
  };
  compose(first);

  // 6. 그림자: 칼선 모양을 한 번 더 흐리게
  const soft = blur(outline, W, H, SHADOW);
  const shadow = canvasOf(W, H);
  const sctx = shadow.getContext('2d');
  const dark = sctx.createImageData(W, H);
  for (let i = 0; i < n; i++) dark.data[i * 4 + 3] = soft[i] * 255;
  sctx.putImageData(dark, 0, 0);

  const mask = new Uint8Array(n);
  for (let i = 0; i < n; i++) mask[i] = outline[i] * 255;

  return {
    canvas: out,
    compose,
    shadow,
    mask,
    width: W,
    height: H,
    bounds: { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 },
  };
}

// ── 기본 스티커 (벡터로 그려서 어디서나 선명하게) ─────────────

const PRESET_DRAW = {
  smile(ctx) {
    const face = ctx.createRadialGradient(196, 176, 30, 256, 256, 220);
    face.addColorStop(0, '#fff27a');
    face.addColorStop(1, '#ffc21a');
    ctx.fillStyle = face;
    ctx.beginPath();
    ctx.arc(256, 256, 210, 0, Math.PI * 2);
    ctx.fill();
    ctx.lineWidth = 10;
    ctx.strokeStyle = '#e39200';
    ctx.stroke();
    ctx.fillStyle = 'rgba(255, 100, 120, 0.45)';
    for (const x of [131, 381]) {
      ctx.beginPath();
      ctx.ellipse(x, 300, 36, 24, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = '#3a2610';
    for (const x of [184, 328]) {
      ctx.beginPath();
      ctx.ellipse(x, 214, 22, 36, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.lineWidth = 22;
    ctx.lineCap = 'round';
    ctx.strokeStyle = '#3a2610';
    ctx.beginPath();
    ctx.arc(256, 276, 110, 0.18 * Math.PI, 0.82 * Math.PI);
    ctx.stroke();
  },

  heart(ctx) {
    const heart = new Path2D();
    heart.moveTo(256, 452);
    heart.bezierCurveTo(96, 344, 26, 250, 58, 158);
    heart.bezierCurveTo(90, 66, 212, 50, 256, 140);
    heart.bezierCurveTo(300, 50, 422, 66, 454, 158);
    heart.bezierCurveTo(486, 250, 416, 344, 256, 452);
    heart.closePath();
    const fill = ctx.createLinearGradient(0, 60, 0, 452);
    fill.addColorStop(0, '#ff7d9c');
    fill.addColorStop(1, '#ef2459');
    ctx.fillStyle = fill;
    ctx.fill(heart);
    ctx.lineWidth = 10;
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#c1103c';
    ctx.stroke(heart);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.6)';
    ctx.beginPath();
    ctx.ellipse(150, 150, 42, 22, -0.65, 0, Math.PI * 2);
    ctx.fill();
  },

  star(ctx) {
    const star = new Path2D();
    for (let i = 0; i < 10; i++) {
      const r = i % 2 ? 100 : 232;
      const a = -Math.PI / 2 + (i * Math.PI) / 5;
      const x = 256 + Math.cos(a) * r;
      const y = 276 + Math.sin(a) * r;
      if (i) star.lineTo(x, y);
      else star.moveTo(x, y);
    }
    star.closePath();
    const fill = ctx.createLinearGradient(0, 40, 0, 470);
    fill.addColorStop(0, '#ffe46b');
    fill.addColorStop(1, '#ffb21a');
    ctx.fillStyle = fill;
    ctx.fill(star);
    ctx.lineWidth = 14;
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#e88a00';
    ctx.stroke(star);
  },

  bolt(ctx) {
    const bolt = new Path2D();
    const points = [
      [304, 28],
      [118, 292],
      [242, 292],
      [190, 484],
      [404, 196],
      [276, 196],
      [344, 28],
    ];
    points.forEach(([x, y], i) => (i ? bolt.lineTo(x, y) : bolt.moveTo(x, y)));
    bolt.closePath();
    ctx.fillStyle = '#ffe14d';
    ctx.fill(bolt);
    ctx.lineWidth = 16;
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#23232a';
    ctx.stroke(bolt);
  },

  wow(ctx) {
    word(ctx, 'WOW!', {
      font: (size) => `italic 900 ${size}px "Arial Black", "Helvetica Neue", Arial, sans-serif`,
      fill: (c, size) => {
        const g = c.createLinearGradient(0, -size / 2, 0, size / 2);
        g.addColorStop(0, '#ff6fb5');
        g.addColorStop(1, '#ff9f1c');
        return g;
      },
      stroke: '#2b1d3a',
      strokeWidth: 22,
      rotate: -0.12,
    });
  },

  hello(ctx) {
    word(ctx, '안녕!', {
      font: (size) => `900 ${size}px "Apple SD Gothic Neo", "Pretendard", "Noto Sans KR", sans-serif`,
      fill: (c, size) => {
        const g = c.createLinearGradient(0, -size / 2, 0, size / 2);
        g.addColorStop(0, '#5ee0ff');
        g.addColorStop(1, '#2f7bff');
        return g;
      },
      stroke: '#0b2a55',
      strokeWidth: 20,
      rotate: 0.06,
    });
  },
};

export const PRESETS = Object.keys(PRESET_DRAW);

export function presetSource(name) {
  const canvas = canvasOf(512, 512);
  PRESET_DRAW[name](canvas.getContext('2d'));
  return canvas;
}

function word(ctx, text, { font, fill, stroke, strokeWidth, rotate }) {
  ctx.save();
  ctx.translate(256, 256);
  ctx.rotate(rotate);
  let size = 220;
  ctx.font = font(size);
  const width = ctx.measureText(text).width;
  if (width > 430) {
    size *= 430 / width;
    ctx.font = font(size);
  }
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.lineWidth = strokeWidth;
  ctx.strokeStyle = stroke;
  ctx.strokeText(text, 0, 0);
  ctx.fillStyle = fill(ctx, size);
  ctx.fillText(text, 0, 0);
  ctx.restore();
}

// ── 도우미 ─────────────────────────────────────────

function canvasOf(width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function smoothstep(edge0, edge1, x) {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

// 알파가 있는 영역의 사각형. 다 투명하면 null
function alphaBox(alpha, width, height) {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (alpha[y * width + x] > 10) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  return maxX < 0 ? null : { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

// 상자 흐림 3번 = 가우시안 근사 (σ ≈ radius)
function blur(src, width, height, radius) {
  const r = Math.max(1, Math.round(radius));
  const a = Float32Array.from(src);
  const b = new Float32Array(src.length);
  for (let pass = 0; pass < 3; pass++) {
    boxBlur(a, b, width, height, r, 1, width); // 가로
    boxBlur(b, a, height, width, r, width, 1); // 세로
  }
  return a;
}

// count 개의 줄을 따라 length 길이만큼 이동 평균. step = 줄 안에서 다음 칸까지 거리, stride = 다음 줄까지 거리
function boxBlur(src, dst, length, count, r, step, stride) {
  const norm = 1 / (2 * r + 1);
  for (let line = 0; line < count; line++) {
    const start = line * stride;
    let sum = 0;
    for (let i = 0; i <= r && i < length; i++) sum += src[start + i * step];
    for (let i = 0; i < length; i++) {
      dst[start + i * step] = sum * norm;
      const add = i + r + 1;
      const remove = i - r;
      if (add < length) sum += src[start + add * step];
      if (remove >= 0) sum -= src[start + remove * step];
    }
  }
}
