import * as THREE from 'three';
import { decodeFrames } from './frames.js';
import { PRESETS, presetSource, cutSticker } from './sticker-art.js';
import { createShadowMaterial, createStickerMaterial, createStickerUniforms } from './sticker-material.js';
import * as store from './store.js';
import * as sound from './sound.js';
import './style.css';

const SEGMENTS = 48; // 말릴 때 매끈하게 휘도록 평면을 잘게 나눔
const DETACH_AT = 0.9; // 이만큼(스티커 길이 대비) 벗겨져야 톡 떨어짐. 접힌 끝이 손을 따라오니 스티커 길이의 1.8배쯤 끌어야 함
const HOLD_FOLLOW = 26; // 들고 있을 때 손을 따라오는 빠르기
const SHEET_FILL = 0.86; // 시트 칸에서 스티커가 차지하는 비율
const MIN_SCALE = 0.35;
const MAX_SCALE = 3;
const MAX_SAVED_BYTES = 15_000_000; // 이보다 큰 움직이는 이미지는 지금만 쓰고 저장하지 않음

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const lerp = (a, b, t) => a + (b - a) * t;
const rand = (lo, hi) => lo + Math.random() * (hi - lo);
const approach = (dt, speed) => 1 - Math.exp(-dt * speed); // 프레임 속도와 무관하게 목표로 다가가는 비율
const inside = (r, x, y) => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
const angleBetween = (a, b) => Math.atan2(b.y - a.y, b.x - a.x);
const distance = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);

// ── 렌더러 ─────────────────────────────────────────────

const canvas = document.querySelector('#stage');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setClearColor(0x000000, 0);
const scene = new THREE.Scene();
// 화면 px 그대로 쓰는 직교 카메라. three 는 y 가 위쪽이라 화면 y 를 뒤집어서 놓음
const camera = new THREE.OrthographicCamera(0, 1, 1, 0, -5000, 5000);
camera.position.z = 2000;

const $ = (selector) => document.querySelector(selector);
const els = {
  sheet: $('#sheet'),
  slots: $('#slots'),
  add: $('.add'),
  file: $('#file'),
  slotRemove: $('#slot-remove'),
  drop: $('#drop'),
  toast: $('#toast'),
  sound: $('#sound'),
  clear: $('#clear'),
  swatches: [...document.querySelectorAll('.swatches button')],
};

// ── 상태 ───────────────────────────────────────────────

const designs = []; // 시트에 있는 도안 (보이는 순서대로)
const stickers = []; // 화면의 모든 스티커 (시트 위 + 판 위)
let boardZ = 100_000; // 판 위 스티커는 늘 시트 스티커보다 위에 그림
let sheetZ = 0;
let action = null; // 지금 벗기거나 들고 있는 것
let gesture = null; // 들고 있는 동안 두 번째 손가락 (회전·크기)
let dirty = true;
let background = 'laptop';
let soundOn = true;

// ── 도안 ───────────────────────────────────────────────

// 판에 붙는 스티커의 긴 변 (px)
function boardSize() {
  return clamp(Math.min(innerWidth, innerHeight) * 0.24, 110, 190);
}

/** frames: [{ image, delay }]. 한 장이면 정지 스티커, 여러 장이면 움직이는 스티커 */
function buildDesign(meta, frames) {
  const art = cutSticker(frames.map((frame) => frame.image));
  const size = boardSize();
  const k = size / Math.max(art.bounds.w, art.bounds.h); // 텍스처 px → 판 px
  const w = art.width * k;
  const h = art.height * k;
  const texture = new THREE.CanvasTexture(art.canvas);
  texture.premultiplyAlpha = true; // 투명한 가장자리에 검은 테가 끼지 않게
  texture.anisotropy = 4;
  const localX = (px) => (px / art.width - 0.5) * w;
  const localY = (py) => (py / art.height - 0.5) * h;
  return {
    ...meta,
    w,
    h,
    size,
    texture,
    shadowTexture: new THREE.CanvasTexture(art.shadow),
    geometry: new THREE.PlaneGeometry(w, h, SEGMENTS, SEGMENTS),
    mask: art.mask,
    maskW: art.width,
    maskH: art.height,
    // 테두리까지 포함한 칼선의 볼록 껍질. 스티커 중심 기준, 화면 방향(y 아래)
    hull: art.hull.map(([px, py]) => ({ x: localX(px), y: localY(py) })),
    // 움직이는 스티커: 프레임이 바뀔 때마다 compose 로 텍스처 캔버스를 다시 그림 (같은 도안의 스티커는 다 같이 움직임)
    frames: frames.length > 1 ? frames : null,
    frame: 0,
    frameTime: 0,
    compose: art.compose,
    slot: null,
    sheetSticker: null,
    removed: false,
  };
}

/** 움직이는 도안들의 프레임 넘기기. 바뀐 게 있으면 true */
function animateDesigns(dt) {
  let changed = false;
  for (const d of designs) {
    if (!d.frames) continue;
    d.frameTime += dt * 1000;
    const before = d.frame;
    while (d.frameTime >= d.frames[d.frame].delay) {
      d.frameTime -= d.frames[d.frame].delay;
      d.frame = (d.frame + 1) % d.frames.length;
    }
    if (d.frame !== before) {
      d.compose(d.frames[d.frame].image);
      d.texture.needsUpdate = true;
      changed = true;
    }
  }
  return changed;
}

function addDesign(design) {
  designs.push(design);
  design.slot = document.createElement('div');
  design.slot.className = 'slot';
  els.slots.insertBefore(design.slot, els.add);
  design.sheetSticker = makeSticker(design, { onSheet: true });
  layoutSheet();
}

/** 시트에서 도안을 지움. 판에 붙인 것도 같이 떨어짐 */
function removeDesign(design) {
  design.removed = true;
  for (const s of stickers) if (s.design === design) fadeOut(s);
  design.slot.remove();
  designs.splice(designs.indexOf(design), 1);
  if (design.kind === 'image') store.remove(`blob:${design.id}`);
  sound.swish();
  layoutSheet();
  save();
}

// ── 스티커 ─────────────────────────────────────────────

function makeSticker(design, { x = 0, y = 0, rotation = 0, scale = 1, onSheet = false } = {}) {
  const uniforms = createStickerUniforms(design.texture);
  const group = new THREE.Group();
  const passes = [0, 1, 2, 3].map((pass) => {
    const mesh = new THREE.Mesh(design.geometry, createStickerMaterial(uniforms, pass));
    mesh.frustumCulled = false; // 셰이더가 모양을 바꾸니 경계 상자로 거르지 않음
    mesh.visible = pass === 0;
    group.add(mesh);
    return mesh;
  });
  const shadow = new THREE.Mesh(design.geometry, createShadowMaterial(uniforms, design.shadowTexture));
  shadow.frustumCulled = false;
  scene.add(shadow, group);

  const sticker = {
    design,
    onSheet,
    pending: false, // 시트에서 벗기는 중인 복제본 (다 떼기 전까지는 판 스티커가 아님)
    x,
    y,
    rotation, // 화면 기준 시계 방향 +
    scale,
    targetScale: scale,
    z: 0,
    lift: 0, // 0 붙음 ~ 1 손에 듦
    liftTarget: 0,
    bounce: 0, // 붙일 때 꾹 눌렸다 돌아오는 스프링
    bounceV: 0,
    sway: 0, // 들고 흔들 때 기울기
    swing: 0, // 떼어 낸 순간 손끝에 매달려 좌우로 흔들리는 각도 (스프링)
    swingV: 0,
    opacity: 1,
    peel: null, // { point, normal, radius } 스티커 로컬, 화면 방향
    settle: null, // 벗기다 놓으면 다시 붙는 중
    unfold: null, // 떼어 낸 직후 접힌 게 펴지는 중 { dir, dist, velocity }
    fly: null, // 시트에서 톡 쳐서 판으로 날아가는 중
    removing: false,
    uniforms,
    group,
    passes,
    shadow,
  };
  setZ(sticker, onSheet ? ++sheetZ : ++boardZ);
  stickers.push(sticker);
  dirty = true;
  return sticker;
}

// 깊이 버퍼 대신 그리는 순서로 겹침을 정함: 그림자 → 바닥 → 말림 아래 → 말림 위 → 뒤집힌 부분
function setZ(s, z) {
  s.z = z;
  s.shadow.renderOrder = z * 8;
  s.passes.forEach((mesh, i) => (mesh.renderOrder = z * 8 + 1 + i));
}

function removeSticker(s) {
  scene.remove(s.group, s.shadow);
  s.passes.forEach((mesh) => mesh.material.dispose());
  s.shadow.material.dispose();
  stickers.splice(stickers.indexOf(s), 1);
  const d = s.design;
  if (d.removed && !stickers.some((other) => other.design === d)) {
    d.texture.dispose();
    d.shadowTexture.dispose();
    d.geometry.dispose();
    d.frames?.forEach((frame) => frame.image.close?.());
  }
  dirty = true;
}

function fadeOut(s) {
  s.removing = true;
  s.liftTarget = 0.5;
}

function placeOnBoard(design, x, y) {
  const s = makeSticker(design, { x, y, rotation: rand(-0.2, 0.2) });
  s.lift = 1;
  stickDown(s);
}

function stickDown(s) {
  s.liftTarget = 0;
  s.bounceV = -1.6; // 손바닥으로 꾹
  sound.stick();
}

/**
 * dir 방향으로 dist 만큼 끌었을 때: 끄는 방향 반대쪽 가장자리부터 말려 올라와서 손을 따라옴.
 * 벗겨진 비율(0~1)을 돌려줌
 */
function setPeel(s, dir, dist) {
  const normal = { x: -dir.x, y: -dir.y };
  const { max, min } = extent(s.design.hull, normal);
  const radius = clamp(dist * 0.2, 1, s.design.size * 0.08);
  // 접힌 가장자리가 손 이동량만큼 따라오려면 접히는 선은 그 절반만 물러나면 됨 (+ 말린 반원 몫)
  const line = max - dist / 2 - (Math.PI * radius) / 2;
  s.peel = { point: { x: normal.x * line, y: normal.y * line }, normal, radius };
  return (max - line) / (max - min);
}

// 스티커 모양(볼록 껍질)을 v 방향으로 비췄을 때 양 끝
function extent(hull, v) {
  let max = -Infinity;
  let min = Infinity;
  for (const p of hull) {
    const u = p.x * v.x + p.y * v.y;
    if (u > max) max = u;
    if (u < min) min = u;
  }
  return { max, min };
}

/** 화면 좌표 → 스티커 로컬 (중심 기준, 회전·크기 되돌림, y 아래) */
function toLocal(s, x, y) {
  const dx = (x - s.x) / s.scale;
  const dy = (y - s.y) / s.scale;
  const c = Math.cos(s.rotation);
  const sn = Math.sin(s.rotation);
  return { x: dx * c + dy * sn, y: -dx * sn + dy * c };
}

/** 그 자리에서 가장 위에 있는 스티커. 투명한 곳은 통과 */
function pick(x, y) {
  let best = null;
  for (const s of stickers) {
    if (s.removing || s.fly || s.settle || s.unfold || s.pending) continue;
    if (best && s.z < best.sticker.z) continue;
    const local = toLocal(s, x, y);
    const { w, h, mask, maskW, maskH } = s.design;
    if (Math.abs(local.x) >= w / 2 || Math.abs(local.y) >= h / 2) continue;
    const mx = Math.floor((local.x / w + 0.5) * maskW);
    const my = Math.floor((local.y / h + 0.5) * maskH);
    if (mask[my * maskW + mx] > 127) best = { sticker: s, local };
  }
  return best;
}

// ── 프레임마다 ─────────────────────────────────────────

function step(s, dt) {
  let moving = false;
  if (Math.abs(s.liftTarget - s.lift) > 0.002) {
    s.lift += (s.liftTarget - s.lift) * approach(dt, 16);
    moving = true;
  } else s.lift = s.liftTarget;

  if (Math.abs(s.targetScale - s.scale) > 0.0005) {
    s.scale += (s.targetScale - s.scale) * approach(dt, 14);
    moving = true;
  } else s.scale = s.targetScale;

  if (Math.abs(s.bounce) > 0.0004 || Math.abs(s.bounceV) > 0.004) {
    s.bounceV += (-520 * s.bounce - 20 * s.bounceV) * dt;
    s.bounce += s.bounceV * dt;
    moving = true;
  } else {
    s.bounce = 0;
    s.bounceV = 0;
  }

  if (s !== action?.sticker && Math.abs(s.sway) > 0.0005) {
    s.sway -= s.sway * approach(dt, 10);
    moving = true;
  }

  if (s.unfold) {
    // 접힌 정도(dist)를 0 으로 당기는 스프링. 들고 있을 땐 덜 감쇠돼서 0 을 지나 반대쪽 끝이 살짝 말렸다 돌아오고,
    // 내려놓으면 임계 감쇠라 출렁임 없이 바로 펴짐
    const u = s.unfold;
    const held = action?.sticker === s;
    u.velocity += (-196 * u.dist - (held ? 14 : 28) * u.velocity) * dt;
    u.dist += u.velocity * dt;
    if (Math.abs(u.dist) < 0.5 && Math.abs(u.velocity) < 5) {
      s.unfold = null;
      s.peel = null;
    } else {
      setPeel(s, u.dist >= 0 ? u.dir : { x: -u.dir.x, y: -u.dir.y }, Math.abs(u.dist));
    }
    moving = true;
  }

  if (Math.abs(s.swing) > 0.0005 || Math.abs(s.swingV) > 0.005) {
    s.swingV += (-90 * s.swing - 3.2 * s.swingV) * dt;
    s.swing += s.swingV * dt;
    moving = true;
  } else {
    s.swing = 0;
    s.swingV = 0;
  }

  if (s.settle) {
    // 벗기다 놓은 건 착 하고 다시 붙음
    s.settle.dist -= s.settle.dist * approach(dt, 18) + dt * 20;
    if (s.settle.dist > 0.5) setPeel(s, s.settle.dir, s.settle.dist);
    else {
      s.settle = null;
      s.peel = null;
      if (s.pending) {
        removeSticker(s);
        return true;
      }
    }
    moving = true;
  }

  if (s.fly) {
    const f = s.fly;
    f.t = Math.min(1, f.t + dt / 0.45);
    const e = 1 - (1 - f.t) ** 3;
    s.x = lerp(f.from.x, f.to.x, e);
    s.y = lerp(f.from.y, f.to.y, e) - Math.sin(Math.PI * f.t) * 70;
    if (f.t >= 1) {
      s.fly = null;
      stickDown(s);
      save();
    }
    moving = true;
  }

  if (s.removing) {
    s.opacity -= dt * 5;
    if (s.opacity <= 0) {
      removeSticker(s);
      return true;
    }
    moving = true;
  }
  return moving;
}

function sync(s) {
  const H = innerHeight;
  const k = s.scale * (1 + 0.06 * s.lift) * (1 + s.bounce);
  const rotation = -(s.rotation + s.sway + s.swing); // 화면(시계 방향 +) → three(반시계 방향 +)
  s.group.position.set(s.x, H - s.y, 0);
  s.group.rotation.z = rotation;
  s.group.scale.set(k, k, k);

  // 들수록 그림자가 멀어지고 커짐
  const spread = k * (1 + 0.035 * s.lift);
  s.shadow.position.set(s.x + lerp(1.5, 9, s.lift), H - s.y - lerp(2.5, 17, s.lift), 0);
  s.shadow.rotation.z = rotation;
  s.shadow.scale.set(spread, spread, 1);
  s.shadow.material.uniforms.uStrength.value = lerp(s.onSheet ? 0.16 : 0.26, 0.34, s.lift) * s.opacity;

  const u = s.uniforms;
  u.uOpacity.value = s.opacity;
  u.uSheen.value = lerp(0.05, 0.13, s.lift);
  u.uPeel.value = s.peel ? 1 : 0;
  if (s.peel) {
    // 화면 방향(y 아래) → three 로컬(y 위)
    u.uFoldPoint.value.set(s.peel.point.x, -s.peel.point.y);
    u.uFoldNormal.value.set(s.peel.normal.x, -s.peel.normal.y);
    u.uRadius.value = s.peel.radius;
  }
  for (let i = 1; i < 4; i++) s.passes[i].visible = !!s.peel;
}

// ── 벗기기 · 들기 · 붙이기 ──────────────────────────────

window.addEventListener(
  'pointerdown',
  (event) => {
    sound.unlock();
    if (action) {
      startGesture(event);
      return;
    }
    if (event.button !== 0 || event.target.closest('button, label, input, a')) return;
    const hit = pick(event.clientX, event.clientY);
    if (!hit) return;
    event.preventDefault();

    let s = hit.sticker;
    if (s.onSheet) {
      // 시트 스티커는 그대로 두고 똑같은 걸 위에 하나 만들어 벗김 → 몇 장이고 뗄 수 있음
      s = makeSticker(s.design, { x: s.x, y: s.y, scale: s.scale });
      s.pending = true;
    } else {
      setZ(s, ++boardZ);
    }
    s.liftTarget = 0.12;
    action = {
      pointerId: event.pointerId,
      sticker: s,
      grab: hit.local, // 손가락 아래 스티커 위의 점
      pointer: { x: event.clientX, y: event.clientY },
      mode: 'press', // press → peel(말아 벗기기) → hold
      dir: null,
      dist: 0,
    };
    try {
      event.target.setPointerCapture(event.pointerId);
    } catch {
      // 합성 이벤트 등은 캡처가 안 될 수 있음
    }
    els.slotRemove.hidden = true;
    document.body.classList.remove('can-grab');
    dirty = true;
  },
  { passive: false },
);

window.addEventListener('pointermove', (event) => {
  if (gesture && event.pointerId === gesture.id) {
    gesture.point = { x: event.clientX, y: event.clientY };
    applyGesture();
    dirty = true;
    return;
  }
  if (!action) {
    hover(event);
    return;
  }
  if (event.pointerId !== action.pointerId) return;
  action.pointer = { x: event.clientX, y: event.clientY };
  if (gesture) applyGesture();
  if (action.mode !== 'hold') peelMove();
  dirty = true;
});

function peelMove() {
  const s = action.sticker;
  const local = toLocal(s, action.pointer.x, action.pointer.y);
  const dx = local.x - action.grab.x;
  const dy = local.y - action.grab.y;
  const dist = Math.hypot(dx, dy);
  if (action.mode === 'press') {
    if (dist * s.scale < 5) return;
    action.mode = 'peel'; // 어디를 잡든 끄는 반대쪽 가장자리부터 말아 올리며 벗김
  }
  if (dist < 0.5) {
    s.peel = null;
    return;
  }
  action.dir = { x: dx / dist, y: dy / dist };
  action.dist = dist;
  if (setPeel(s, action.dir, dist) >= DETACH_AT) detach();
}

function detach() {
  const s = action.sticker;
  action.mode = 'hold';
  // 바로 평평해지지 않고 접힌 채로 떨어져서, 스프링으로 휙 펴지며 반대쪽 끝이 살짝 들썩였다 가라앉음
  s.unfold = { dir: action.dir, dist: action.dist, velocity: 0 };
  // 손끝에 매달린 것처럼 좌우로 달랑달랑
  const side = Math.abs(action.dir.x) > 0.2 ? -Math.sign(action.dir.x) : Math.sign(rand(-1, 1));
  s.swingV = side * rand(1.1, 1.5);
  s.liftTarget = 1;
  s.bounceV = 0.6;
  if (s.pending) {
    s.pending = false;
    s.targetScale = 1;
    s.rotation += rand(-0.12, 0.12);
  }
  setZ(s, ++boardZ);
  document.body.classList.add('is-holding');
  sound.peel();
}

// 잡은 점이 손가락 밑에 오도록 따라감 (살짝 늦게 따라와서 무게감이 있음)
function updateHold(dt) {
  const s = action.sticker;
  const k = s.scale * (1 + 0.06 * s.lift);
  const c = Math.cos(s.rotation);
  const sn = Math.sin(s.rotation);
  const gx = action.grab.x * k;
  const gy = action.grab.y * k;
  const tx = action.pointer.x - (gx * c - gy * sn);
  const ty = action.pointer.y - (gx * sn + gy * c);
  const before = s.x;
  const a = approach(dt, HOLD_FOLLOW);
  s.x += (tx - s.x) * a;
  s.y += (ty - s.y) * a;
  const vx = (s.x - before) / Math.max(dt, 1e-3);
  s.sway += (clamp(vx * 0.00035, -0.14, 0.14) - s.sway) * approach(dt, 8);
  els.sheet.classList.toggle('is-target', overSheet(action.pointer));
}

function release() {
  const { sticker: s, mode } = action;
  els.sheet.classList.remove('is-target');
  document.body.classList.remove('is-holding');
  if (mode === 'hold') {
    if (overSheet(action.pointer)) {
      fadeOut(s); // 시트 위에 놓으면 돌려놓기 (= 판에서 없앰)
      sound.swish();
    } else stickDown(s);
  } else if (mode === 'press' && s.pending) {
    flyToBoard(s); // 시트 스티커를 톡 치면 판 아무 데나 날아가 붙음
  } else {
    s.liftTarget = 0;
    if (s.peel) s.settle = { dir: action.dir, dist: action.dist };
    else if (s.pending) removeSticker(s);
    else if (mode === 'press') s.bounceV = 1; // 판 스티커를 톡 치면 살짝 들썩
  }
  action = null;
  gesture = null;
  dirty = true;
  save();
}

function flyToBoard(s) {
  const sheetTop = els.sheet.getBoundingClientRect().top;
  const margin = s.design.size * 0.6;
  const top = 110 + margin * 0.5;
  const bottom = sheetTop - margin;
  s.pending = false;
  s.targetScale = 1;
  s.rotation = rand(-0.3, 0.3);
  s.liftTarget = 1;
  s.fly = {
    from: { x: s.x, y: s.y },
    to: { x: rand(margin, innerWidth - margin), y: rand(Math.min(top, bottom), Math.max(top, bottom)) },
    t: 0,
  };
  setZ(s, ++boardZ);
  sound.peel();
}

function onPointerEnd(event) {
  if (gesture && event.pointerId === gesture.id) {
    gesture = null;
    return;
  }
  if (action && event.pointerId === action.pointerId) release();
}
window.addEventListener('pointerup', onPointerEnd);
window.addEventListener('pointercancel', onPointerEnd);
window.addEventListener('blur', () => action && release());

// 들고 있을 때 두 번째 손가락: 비틀면 회전, 벌리면 크기
function startGesture(event) {
  if (action?.mode !== 'hold' || event.pointerType !== 'touch' || gesture) return;
  const s = action.sticker;
  const point = { x: event.clientX, y: event.clientY };
  gesture = {
    id: event.pointerId,
    point,
    angle: angleBetween(action.pointer, point),
    span: Math.max(24, distance(action.pointer, point)),
    rotation: s.rotation,
    scale: s.targetScale,
  };
}

function applyGesture() {
  const s = action.sticker;
  s.rotation = gesture.rotation + angleBetween(action.pointer, gesture.point) - gesture.angle;
  s.targetScale = clamp((gesture.scale * distance(action.pointer, gesture.point)) / gesture.span, MIN_SCALE, MAX_SCALE);
}

// 들고 있을 때 휠: 회전, ⇧/⌃/⌥ + 휠(트랙패드 핀치 포함): 크기
window.addEventListener(
  'wheel',
  (event) => {
    if (action?.mode !== 'hold') return;
    event.preventDefault();
    const s = action.sticker;
    const delta = event.deltaY || event.deltaX;
    if (event.shiftKey || event.ctrlKey || event.altKey) {
      s.targetScale = clamp(s.targetScale * Math.exp(-delta * 0.004), MIN_SCALE, MAX_SCALE);
    } else s.rotation += delta * 0.004;
    dirty = true;
  },
  { passive: false },
);

window.addEventListener('keydown', (event) => {
  if (action?.mode !== 'hold') return;
  const turn = { q: -1, e: 1 }[event.key.toLowerCase()];
  if (!turn) return;
  action.sticker.rotation += (turn * Math.PI) / 12;
  dirty = true;
});

function hover(event) {
  if (event.pointerType !== 'mouse') return;
  document.body.classList.toggle('can-grab', !!pick(event.clientX, event.clientY));
  // 시트 칸 위에 올리면 지우기 버튼
  const design = designs.find((d) => inside(d.slot.getBoundingClientRect(), event.clientX, event.clientY));
  if (design) {
    const r = design.slot.getBoundingClientRect();
    els.slotRemove.hidden = false;
    els.slotRemove.style.transform = `translate(${r.right - 16}px, ${r.top - 8}px)`;
    els.slotRemove.dataset.id = design.id;
  } else if (!event.target.closest?.('#slot-remove')) {
    els.slotRemove.hidden = true;
  }
}

function overSheet(point) {
  return inside(els.sheet.getBoundingClientRect(), point.x, point.y);
}

// ── 시트 · 화면 크기 ───────────────────────────────────

function layoutSheet() {
  // 칸을 줄여서라도 한 줄에 넣고, 너무 작아지면 그때 줄을 늘림
  const count = designs.length + 1;
  const width = els.slots.clientWidth;
  const gap = 8;
  const largest = innerWidth < 600 ? 66 : 84;
  const rowsAt = (size) => Math.ceil(count / Math.max(1, Math.floor((width + gap) / (size + gap))));
  let slot = largest;
  for (let rows = 1; ; rows++) {
    slot = largest;
    while (slot > 52 && rowsAt(slot) > rows) slot -= 2;
    if (rowsAt(slot) <= rows && (slot >= 60 || rows > 1)) break;
  }
  els.slots.style.setProperty('--slot', `${slot}px`);

  for (const d of designs) {
    const r = d.slot.getBoundingClientRect();
    const s = d.sheetSticker;
    s.x = r.left + r.width / 2;
    s.y = r.top + r.height / 2;
    s.scale = s.targetScale = (Math.min(r.width, r.height) * SHEET_FILL) / d.size;
  }
  dirty = true;
}

function resize() {
  const W = innerWidth;
  const H = innerHeight;
  renderer.setSize(W, H, false);
  camera.right = W;
  camera.top = H;
  camera.updateProjectionMatrix();
  layoutSheet();
  for (const s of stickers) {
    if (s.onSheet) continue;
    s.x = clamp(s.x, 0, W);
    s.y = clamp(s.y, 0, H);
  }
  dirty = true;
}
window.addEventListener('resize', resize);

// ── 이미지 넣기 (파일 고르기 · 끌어 놓기 · 붙여 넣기) ───────

els.file.addEventListener('change', () => {
  addFiles([...els.file.files]);
  els.file.value = '';
});

const hasFiles = (event) => [...(event.dataTransfer?.types ?? [])].includes('Files');
let dragDepth = 0;
window.addEventListener('dragenter', (event) => {
  if (!hasFiles(event)) return;
  event.preventDefault();
  dragDepth++;
  els.drop.hidden = false;
});
window.addEventListener('dragover', (event) => {
  if (hasFiles(event)) event.preventDefault();
});
window.addEventListener('dragleave', (event) => {
  if (!hasFiles(event)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) els.drop.hidden = true;
});
window.addEventListener('drop', (event) => {
  if (!hasFiles(event)) return;
  event.preventDefault();
  dragDepth = 0;
  els.drop.hidden = true;
  addFiles([...event.dataTransfer.files], { x: event.clientX, y: event.clientY });
});
window.addEventListener('paste', (event) => {
  const files = [...(event.clipboardData?.files ?? [])];
  if (files.length) addFiles(files, { x: innerWidth / 2, y: innerHeight * 0.4 });
});

/** 시트에 도안으로 추가. 판 위에 놓았으면 그 자리에 한 장 붙임 */
async function addFiles(files, at) {
  const images = files.filter((file) => file.type.startsWith('image/'));
  if (!images.length) {
    toast('이미지 파일만 스티커로 만들 수 있어요');
    return;
  }
  let placed = 0;
  for (const file of images) {
    try {
      const id = crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
      if (file.type === 'image/gif') {
        toast('GIF 푸는 중…');
        await new Promise(requestAnimationFrame); // 알림이 먼저 그려지게
      }
      const frames = await decodeFrames(file).catch(() => null);
      let design;
      if (frames) {
        // 움직이는 이미지는 원본 그대로 저장 (PNG 로 다시 구우면 움직임이 사라짐)
        design = buildDesign({ id, kind: 'image' }, frames);
        if (file.size <= MAX_SAVED_BYTES) store.set(`blob:${id}`, file);
        else toast('GIF 가 커서 새로 고치면 사라져요');
      } else {
        const { blob, source } = await normalize(file);
        design = buildDesign({ id, kind: 'image' }, [{ image: source }]);
        source.close?.();
        store.set(`blob:${id}`, blob);
      }
      addDesign(design);
      if (at && !overSheet(at)) placeOnBoard(design, at.x + placed * 28, at.y + placed * 28);
      placed++;
    } catch {
      toast(`${file.name} 은(는) 읽지 못했어요`);
    }
  }
  save();
}

/** 너무 큰 원본은 긴 변 1024 PNG 로 줄여서 저장 */
async function normalize(file) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 1024 / Math.max(bitmap.width, bitmap.height));
  if (scale === 1 && file.size < 3_000_000) return { blob: file, source: bitmap };
  const resized = document.createElement('canvas');
  resized.width = Math.max(1, Math.round(bitmap.width * scale));
  resized.height = Math.max(1, Math.round(bitmap.height * scale));
  resized.getContext('2d').drawImage(bitmap, 0, 0, resized.width, resized.height);
  bitmap.close();
  const blob = await new Promise((resolve) => resized.toBlob(resolve, 'image/png'));
  return { blob, source: resized };
}

// ── 위쪽 도구 ──────────────────────────────────────────

function applyBackground() {
  document.body.dataset.bg = background;
  for (const button of els.swatches) button.setAttribute('aria-checked', String(button.dataset.bg === background));
}
for (const button of els.swatches) {
  button.addEventListener('click', () => {
    background = button.dataset.bg;
    applyBackground();
    save();
  });
}

function applySound() {
  sound.setEnabled(soundOn);
  els.sound.classList.toggle('is-muted', !soundOn);
  els.sound.setAttribute('aria-pressed', String(soundOn));
}
els.sound.addEventListener('click', () => {
  soundOn = !soundOn;
  applySound();
  save();
});

let clearArmed = 0;
els.clear.addEventListener('click', () => {
  const placed = stickers.filter((s) => !s.onSheet && !s.pending && !s.removing);
  if (!placed.length) {
    toast('판이 이미 비어 있어요');
    return;
  }
  if (!clearArmed) {
    els.clear.textContent = '한 번 더 누르면 다 떼요';
    clearArmed = setTimeout(() => {
      clearArmed = 0;
      els.clear.textContent = '판 비우기';
    }, 2500);
    return;
  }
  clearTimeout(clearArmed);
  clearArmed = 0;
  els.clear.textContent = '판 비우기';
  placed.forEach(fadeOut);
  sound.swish();
  save();
});

els.slotRemove.addEventListener('click', () => {
  const design = designs.find((d) => d.id === els.slotRemove.dataset.id);
  els.slotRemove.hidden = true;
  if (design) removeDesign(design);
});

let toastTimer = 0;
function toast(text) {
  els.toast.textContent = text;
  els.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.remove('show'), 2200);
}

// ── 저장 · 불러오기 ────────────────────────────────────

let saveTimer = 0;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    store.set('state', {
      version: 1,
      background,
      sound: soundOn,
      designs: designs.map(({ id, kind, preset }) => ({ id, kind, preset })),
      // 위치는 화면 비율로 저장해서 창 크기가 달라도 비슷한 자리에
      placed: stickers
        .filter((s) => !s.onSheet && !s.pending && !s.removing)
        .sort((a, b) => a.z - b.z)
        .map((s) => ({
          design: s.design.id,
          x: s.x / innerWidth,
          y: s.y / innerHeight,
          rotation: s.rotation,
          scale: s.targetScale,
        })),
    });
  }, 250);
}

async function restore() {
  const state = await store.get('state');
  if (!state) return false;
  background = state.background ?? background;
  soundOn = state.sound ?? soundOn;
  for (const meta of state.designs) {
    const frames = await framesOf(meta);
    if (!frames) continue;
    const design = buildDesign(meta, frames);
    if (frames.length === 1) frames[0].image.close?.(); // 정지 이미지는 텍스처에 다 옮겼으니 원본은 놓아줌
    addDesign(design);
  }
  const byId = new Map(designs.map((d) => [d.id, d]));
  for (const p of state.placed) {
    const design = byId.get(p.design);
    if (design) makeSticker(design, { x: p.x * innerWidth, y: p.y * innerHeight, rotation: p.rotation, scale: p.scale });
  }
  return true;
}

/** 저장된 도안을 다시 프레임으로 (정지 이미지는 한 장) */
async function framesOf(meta) {
  if (meta.kind === 'preset') return PRESETS.includes(meta.preset) ? [{ image: presetSource(meta.preset) }] : null;
  const blob = await store.get(`blob:${meta.id}`);
  if (!blob) return null;
  const animated = await decodeFrames(blob).catch(() => null);
  if (animated) return animated;
  const image = await createImageBitmap(blob).catch(() => null);
  return image ? [{ image }] : null;
}

// 처음 열면 기본 스티커들 + 판에 몇 장 붙여 둠
function seed() {
  for (const preset of PRESETS) {
    addDesign(buildDesign({ id: `preset-${preset}`, kind: 'preset', preset }, [{ image: presetSource(preset) }]));
  }
  const find = (preset) => designs.find((d) => d.preset === preset);
  const W = innerWidth;
  const H = innerHeight;
  makeSticker(find('wow'), { x: W * 0.3, y: H * 0.33, rotation: -0.14 });
  makeSticker(find('heart'), { x: W * 0.67, y: H * 0.3, rotation: 0.18 });
  makeSticker(find('smile'), { x: W * 0.5, y: H * 0.5, rotation: -0.05 });
}

// ── 시작 ───────────────────────────────────────────────

// 인터랙션·애니메이션은 60fps 고정 스텝. 120Hz 화면에선 한 프레임씩 건너뛰고, 밀리면 최대 4스텝까지 따라잡음
const FRAME_MS = 1000 / 60;
const STEP = 1 / 60;
let clock = performance.now();

function tick() {
  let active = false;
  if (action?.mode === 'hold') {
    updateHold(STEP);
    active = true;
  }
  if (animateDesigns(STEP)) active = true;
  for (const s of [...stickers]) if (step(s, STEP)) active = true;
  return active;
}

renderer.setAnimationLoop((now) => {
  const pending = now - clock;
  if (pending < FRAME_MS - 1) return; // 다음 60fps 프레임 시간이 아직 안 됨 (1ms 는 타이밍 흔들림 여유)
  const steps = Math.min(4, Math.max(1, Math.round(pending / FRAME_MS)));
  clock = steps === 4 ? now : clock + steps * FRAME_MS; // 60fps 박자 유지, 너무 밀렸으면 지금으로 맞춤
  let active = dirty;
  dirty = false;
  for (let i = 0; i < steps; i++) if (tick()) active = true;
  if (!active) return; // 움직이는 게 없으면 다시 그리지 않음
  for (const s of stickers) sync(s);
  renderer.render(scene, camera);
});

resize();
restore().then((restored) => {
  if (!restored) seed();
  applyBackground();
  applySound();
  layoutSheet();
});
