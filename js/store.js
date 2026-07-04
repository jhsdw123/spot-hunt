// Persistence with graceful degradation:
// 1. CrazyGames data module when available (required for progress-saving games
//    on CG — syncs with the player's account; localStorage-compatible API)
// 2. localStorage
// 3. per-session memory (sandboxed portal iframes can deny storage entirely)
const mem = new Map();

function cgData() {
  try {
    const d = window.CrazyGames?.SDK?.data;
    return d && typeof d.getItem === 'function' ? d : null;
  } catch { return null; }
}

export function storeGet(key) {
  const d = cgData();
  if (d) { try { return d.getItem(key); } catch {} }
  try { return localStorage.getItem(key); } catch { return mem.has(key) ? mem.get(key) : null; }
}

export function storeSet(key, value) {
  const d = cgData();
  if (d) { try { d.setItem(key, String(value)); return; } catch {} }
  try { localStorage.setItem(key, value); } catch { mem.set(key, String(value)); }
}
