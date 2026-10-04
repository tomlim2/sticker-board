// 움직이는 이미지(GIF, 움직이는 WebP·PNG) → 프레임 목록 [{ image: ImageBitmap, delay: ms }].
// 브라우저 내장 ImageDecoder 를 먼저 쓰고, 없는 브라우저에선 GIF 만 omggif 로 직접 풀어냄.
// 한 장짜리(움직이지 않는) 이미지면 null.

const MAX_FRAMES = 120; // 이보다 길면 프레임을 건너뛰며 줄임
const MAX_SIDE = 384; // 프레임 긴 변. 스티커 크기엔 이거면 충분하고 메모리를 아낌

export async function decodeFrames(blob) {
  if ('ImageDecoder' in window) {
    const frames = await viaImageDecoder(blob).catch(() => undefined);
    if (frames !== undefined) return frames;
  }
  if (blob.type === 'image/gif') return viaGifReader(blob);
  return null;
}

// undefined = 이 형식은 못 풂 (다른 방법으로), null = 한 장짜리
async function viaImageDecoder(blob) {
  if (!(await ImageDecoder.isTypeSupported(blob.type))) return undefined;
  const decoder = new ImageDecoder({ data: await blob.arrayBuffer(), type: blob.type });
  try {
    await decoder.tracks.ready;
    await decoder.completed;
    const total = decoder.tracks.selectedTrack?.frameCount ?? 1;
    if (total <= 1) return null;
    const step = Math.ceil(total / MAX_FRAMES);
    const frames = [];
    for (let i = 0; i < total; i += step) {
      const { image } = await decoder.decode({ frameIndex: i });
      const delay = image.duration ? image.duration / 1000 : 100; // µs → ms
      frames.push({ image: await shrink(image, image.displayWidth, image.displayHeight), delay: normalizeDelay(delay) * step });
      image.close();
    }
    return frames;
  } finally {
    decoder.close();
  }
}

async function viaGifReader(blob) {
  const omggif = await import('omggif');
  const GifReader = omggif.GifReader ?? omggif.default.GifReader;
  const reader = new GifReader(new Uint8Array(await blob.arrayBuffer()));
  const total = reader.numFrames();
  if (total <= 1) return null;
  const { width, height } = reader;
  const screen = new Uint8ClampedArray(width * height * 4); // 지금까지 합성된 화면
  const step = Math.ceil(total / MAX_FRAMES);
  const frames = [];
  for (let i = 0; i < total; i++) {
    const info = reader.frameInfo(i);
    const before = info.disposal === 3 ? screen.slice() : null;
    reader.decodeAndBlitFrameRGBA(i, screen); // 투명한 칸은 그대로 두고 덮음
    if (i % step === 0) {
      const image = await shrink(new ImageData(screen.slice(), width, height), width, height);
      frames.push({ image, delay: normalizeDelay(info.delay * 10) * step });
    }
    // 다음 프레임 그리기 전에 이 프레임 치우기 (GIF disposal: 2 = 배경으로, 3 = 이전 화면으로)
    if (info.disposal === 2) {
      for (let y = info.y; y < info.y + info.height; y++) {
        screen.fill(0, (y * width + info.x) * 4, (y * width + info.x + info.width) * 4);
      }
    } else if (before) screen.set(before);
  }
  return frames;
}

function shrink(source, width, height) {
  const scale = Math.min(1, MAX_SIDE / Math.max(width, height));
  if (scale === 1) return createImageBitmap(source);
  return createImageBitmap(source, {
    resizeWidth: Math.max(1, Math.round(width * scale)),
    resizeHeight: Math.max(1, Math.round(height * scale)),
    resizeQuality: 'high',
  });
}

// 브라우저들처럼 0~10ms 지연은 100ms 로 (그대로 두면 미친 듯이 빨라짐)
function normalizeDelay(ms) {
  return ms <= 10 ? 100 : ms;
}
