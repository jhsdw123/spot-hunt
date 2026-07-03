// Puzzle data source — the Spot the Difference Studio library (same GitHub Pages origin).
const LIB_BASE = 'https://jhsdw123.github.io/spot-difference-studio/library';

let entries = null;

export async function loadPuzzles() {
  if (entries) return entries;
  const res = await fetch(`${LIB_BASE}/manifest.json`);
  if (!res.ok) throw new Error('puzzle library unavailable');
  const manifest = await res.json();
  entries = manifest.map(e => ({
    id: e.id,
    count: e.count,
    regions: e.regions,
    style: e.style || 'photo',
    aUrl: `${LIB_BASE}/img/${e.id}_a.webp`,
    bUrl: `${LIB_BASE}/img/${e.id}_b.webp`,
  }));
  return entries;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Deterministic level order per mode so every player gets the same sequence.
export function levelSequence(mode) {
  const pool = entries.filter(e => mode === 'mixed' ? true : e.style === mode);
  const rng = mulberry32(0xC0FFEE);
  const order = pool.map((_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  return order.map(i => pool[i]);
}

export function poolSize(mode) {
  if (!entries) return 0;
  return mode === 'mixed' ? entries.length : entries.filter(e => e.style === mode).length;
}
