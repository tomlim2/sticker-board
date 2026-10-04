// 효과음. 샘플 파일 없이 WebAudio 노이즈로 합성

let ctx = null;
let master = null;
let noise = null;
let enabled = true;

/** 브라우저 정책상 사용자 입력 안에서 한 번 불러야 소리가 남 */
export function unlock() {
  if (!ctx) {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) return;
    ctx = new AudioContext();
    master = ctx.createGain();
    master.gain.value = 0.5;
    master.connect(ctx.destination);
    noise = ctx.createBuffer(1, ctx.sampleRate * 0.5, ctx.sampleRate);
    const data = noise.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  }
  if (ctx.state === 'suspended') ctx.resume();
}

export function setEnabled(on) {
  enabled = on;
}

/** 끈적하게 떨어지는 '지익' — 올라가는 대역 필터 노이즈 */
export function peel() {
  if (!ready()) return;
  const t = ctx.currentTime;
  const filter = ctx.createBiquadFilter();
  filter.type = 'bandpass';
  filter.Q.value = 2.2;
  filter.frequency.setValueAtTime(700, t);
  filter.frequency.exponentialRampToValueAtTime(4200, t + 0.16);
  burst(filter, t, 0.2, 0.55);
}

/** 손바닥으로 '탁' 붙이기 — 낮은 쿵 + 짧은 딱 */
export function stick() {
  if (!ready()) return;
  const t = ctx.currentTime;
  const thump = ctx.createOscillator();
  thump.frequency.setValueAtTime(150, t);
  thump.frequency.exponentialRampToValueAtTime(70, t + 0.08);
  const gain = ctx.createGain();
  envelope(gain.gain, t, 0.1, 0.7);
  thump.connect(gain).connect(master);
  thump.start(t);
  thump.stop(t + 0.12);
  const filter = ctx.createBiquadFilter();
  filter.type = 'highpass';
  filter.frequency.value = 2500;
  burst(filter, t, 0.03, 0.35);
}

/** 시트로 돌려놓거나 지울 때 '샥' */
export function swish() {
  if (!ready()) return;
  const t = ctx.currentTime;
  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.setValueAtTime(3000, t);
  filter.frequency.exponentialRampToValueAtTime(600, t + 0.15);
  burst(filter, t, 0.17, 0.4);
}

function ready() {
  return enabled && ctx?.state === 'running';
}

function burst(filter, t, length, peak) {
  const source = ctx.createBufferSource();
  source.buffer = noise;
  const gain = ctx.createGain();
  envelope(gain.gain, t, length, peak);
  source.connect(filter).connect(gain).connect(master);
  source.start(t, Math.random() * 0.25);
  source.stop(t + length + 0.02);
}

function envelope(param, t, length, peak) {
  param.setValueAtTime(0.0001, t);
  param.exponentialRampToValueAtTime(peak, t + 0.012);
  param.exponentialRampToValueAtTime(0.0001, t + length);
}
