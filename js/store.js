// localStorage can throw inside sandboxed portal iframes (storage denied) —
// degrade to a per-session in-memory map instead of crashing the module graph.
const mem = new Map();

export function storeGet(key) {
  try { return localStorage.getItem(key); } catch { return mem.has(key) ? mem.get(key) : null; }
}

export function storeSet(key, value) {
  try { localStorage.setItem(key, value); } catch { mem.set(key, String(value)); }
}
