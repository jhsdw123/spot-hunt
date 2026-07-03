// Tiny WebAudio SFX — synthesized, no asset files.
let ctx = null;
let muted = localStorage.getItem('sh_muted') === '1';

function ac() {
  if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

function tone(freq, dur, { type = 'sine', gain = 0.12, when = 0, slide = 0 } = {}) {
  if (muted) return;
  const c = ac();
  const t0 = c.currentTime + when;
  const o = c.createOscillator();
  const g = c.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t0);
  if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(40, freq + slide), t0 + dur);
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(gain, t0 + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  o.connect(g).connect(c.destination);
  o.start(t0); o.stop(t0 + dur + 0.05);
}

export const sfx = {
  found() { tone(880, 0.12, { gain: 0.14 }); tone(1320, 0.22, { when: 0.07, gain: 0.12 }); },
  miss() { tone(160, 0.18, { type: 'square', gain: 0.07, slide: -60 }); },
  hint() { tone(660, 0.1, { gain: 0.1 }); tone(660, 0.1, { when: 0.14, gain: 0.1 }); },
  tick() { tone(1000, 0.04, { type: 'square', gain: 0.04 }); },
  win() { [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.22, { when: i * 0.1, gain: 0.13 })); },
  lose() { [330, 262, 196].forEach((f, i) => tone(f, 0.3, { when: i * 0.16, type: 'triangle', gain: 0.1 })); },
  click() { tone(700, 0.05, { type: 'triangle', gain: 0.07 }); },
  siren() {
    for (let i = 0; i < 3; i++) {
      tone(760, 0.16, { type: 'square', gain: 0.06, when: i * 0.36 });
      tone(980, 0.16, { type: 'square', gain: 0.06, when: i * 0.36 + 0.18 });
    }
  },
};

export function toggleMute() {
  muted = !muted;
  localStorage.setItem('sh_muted', muted ? '1' : '0');
  return muted;
}
export function isMuted() { return muted; }
export function vibrate(pattern) { if (navigator.vibrate) navigator.vibrate(pattern); }
