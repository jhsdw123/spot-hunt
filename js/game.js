// Round engine: synchronized dual-panel zoom/pan, tap hit-testing, timer, hints.
import { sfx, vibrate } from './audio.js';

const ZOOM_MAX = 4;

export class Round {
  constructor(puzzle, els, cb, opts = {}) {
    this.puzzle = puzzle;
    this.els = els;           // { panels: [elA, elB], inners: [a, b], timerBar, timerText, foundDots, hintBtn }
    this.cb = cb;             // { onProgress, onWin, onLose }
    // solo: pause while the tab is hidden. versus: keep wall-clock time so one
    // player backgrounding their phone can never freeze the match.
    this.pauseOnHide = opts.pauseOnHide !== false;
    this.found = new Set();
    this.misses = 0;
    this.hintsUsed = 0;
    this.totalTime = 45 + 15 * puzzle.count;
    this.timeLeft = this.totalTime;
    this.elapsed = 0;
    this.running = false;
    this.zoom = { s: 1, tx: 0, ty: 0 };
    this.pointers = new Map();
    this.pinch = null;
    this.pan = null;
    this._raf = null;
    this._lastTs = 0;
    this._tickSec = -1;
    this._handlers = [];
    this._bindPanels();
    this._onVis = () => {
      if (!this.pauseOnHide) {
        // rAF stops while hidden; on return the first frame's dt covers the whole
        // hidden period, so real time is deducted automatically. Nothing to do.
        return;
      }
      if (document.hidden) this._pause(); else this._resume();
    };
    document.addEventListener('visibilitychange', this._onVis);
  }

  /* ---------- lifecycle ---------- */
  start() {
    this.running = true;
    this._lastTs = performance.now();
    const loop = (ts) => {
      if (!this.destroyed) {
        if (this.running) {
          const dt = (ts - this._lastTs) / 1000;
          this.timeLeft -= dt;
          this.elapsed += dt;
          this._renderTimer();
          if (this.timeLeft <= 0) { this._lose(); return; }
        }
        this._lastTs = ts;
        this._raf = requestAnimationFrame(loop);
      }
    };
    this._raf = requestAnimationFrame(loop);
  }

  // freeze the round without firing win/lose callbacks (versus: opponent finished first)
  halt() { this.finished = true; this.running = false; }

  // show where the remaining answers were (timeout / review phase)
  revealAnswers() {
    this.puzzle.regions.forEach((r, i) => {
      if (this.found.has(i)) return;
      this.els.inners.forEach(inner => {
        if (inner.querySelector(`.reveal-ring[data-i="${i}"]`)) return;
        const ring = document.createElement('div');
        ring.className = 'reveal-ring';
        ring.dataset.i = i;
        ring.style.left = `${r.x}%`; ring.style.top = `${r.y}%`;
        ring.style.width = ring.style.height = `${Math.max(r.radius, 5) * 2.4}%`;
        inner.appendChild(ring);
      });
    });
  }

  _pause() { this.running = false; }
  _resume() { if (!this.destroyed && !this.finished) { this.running = true; this._lastTs = performance.now(); } }

  destroy() {
    this.destroyed = true;
    cancelAnimationFrame(this._raf);
    document.removeEventListener('visibilitychange', this._onVis);
    for (const [el, type, fn] of this._handlers) el.removeEventListener(type, fn);
    this.els.panels.forEach(p => p.querySelectorAll('.marker,.hint-ring,.miss-x,.reveal-ring').forEach(m => m.remove()));
  }

  /* ---------- timer ---------- */
  _renderTimer() {
    const frac = Math.max(0, this.timeLeft / this.totalTime);
    this.els.timerBar.style.transform = `scaleX(${frac})`;
    this.els.timerBar.classList.toggle('low', this.timeLeft < 15);
    const s = Math.max(0, Math.ceil(this.timeLeft));
    this.els.timerText.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    if (this.timeLeft < 10 && s !== this._tickSec) { this._tickSec = s; sfx.tick(); }
  }

  /* ---------- input ---------- */
  _bindPanels() {
    this.els.panels.forEach((panel, pi) => {
      const on = (type, fn, opts) => {
        panel.addEventListener(type, fn, opts || { passive: false });
        this._handlers.push([panel, type, fn]);
      };
      on('pointerdown', e => this._down(e, panel));
      on('pointermove', e => this._move(e, panel));
      on('pointerup', e => this._up(e, panel, pi));
      on('pointercancel', e => { this.pointers.delete(e.pointerId); this.pinch = null; this.pan = null; });
      on('wheel', e => { e.preventDefault(); this._wheel(e, panel); });
    });
  }

  _local(e, panel) {
    const r = panel.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top, size: r.width };
  }

  _down(e, panel) {
    if (this.finished) return;
    panel.setPointerCapture(e.pointerId);
    const p = this._local(e, panel);
    this.pointers.set(e.pointerId, p);
    if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      this.pinch = {
        startDist: Math.hypot(a.x - b.x, a.y - b.y),
        startScale: this.zoom.s,
        startT: { tx: this.zoom.tx, ty: this.zoom.ty },
        mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
      };
      this.pan = null;
    } else if (this.pointers.size === 1) {
      this.pan = { start: p, startT: { tx: this.zoom.tx, ty: this.zoom.ty }, moved: false, t0: performance.now() };
    }
  }

  _move(e, panel) {
    if (!this.pointers.has(e.pointerId)) return;
    const p = this._local(e, panel);
    this.pointers.set(e.pointerId, p);
    if (this.pinch && this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      const s2 = Math.min(ZOOM_MAX, Math.max(1, this.pinch.startScale * (dist / this.pinch.startDist)));
      const k = s2 / this.pinch.startScale;
      this._setZoom(s2,
        this.pinch.mid.x - (this.pinch.mid.x - this.pinch.startT.tx) * k,
        this.pinch.mid.y - (this.pinch.mid.y - this.pinch.startT.ty) * k,
        panel);
    } else if (this.pan && this.pointers.size === 1) {
      const dx = p.x - this.pan.start.x, dy = p.y - this.pan.start.y;
      if (Math.hypot(dx, dy) > 12) this.pan.moved = true;
      if (this.pan.moved && this.zoom.s > 1) {
        this._setZoom(this.zoom.s, this.pan.startT.tx + dx, this.pan.startT.ty + dy, panel);
      }
    }
  }

  _up(e, panel, pi) {
    const p = this.pointers.get(e.pointerId);
    this.pointers.delete(e.pointerId);
    if (this.pinch && this.pointers.size < 2) { this.pinch = null; return; }
    if (this.pan && p) {
      const quick = performance.now() - this.pan.t0 < 600;
      if (!this.pan.moved && quick && this.running) this._tap(p, panel, pi);
      this.pan = null;
    }
  }

  _wheel(e, panel) {
    const p = this._local(e, panel);
    const s2 = Math.min(ZOOM_MAX, Math.max(1, this.zoom.s * (e.deltaY < 0 ? 1.18 : 0.85)));
    const k = s2 / this.zoom.s;
    this._setZoom(s2, p.x - (p.x - this.zoom.tx) * k, p.y - (p.y - this.zoom.ty) * k, panel);
  }

  _setZoom(s, tx, ty, refPanel) {
    const size = refPanel.getBoundingClientRect().width;
    const min = size - s * size;
    this.zoom = {
      s,
      tx: s === 1 ? 0 : Math.min(0, Math.max(min, tx)),
      ty: s === 1 ? 0 : Math.min(0, Math.max(min, ty)),
    };
    const t = `translate(${this.zoom.tx}px, ${this.zoom.ty}px) scale(${s})`;
    this.els.inners.forEach(i => { i.style.transform = t; });
    document.body.classList.toggle('zoomed', s > 1);
  }

  resetZoom() { this._setZoom(1, 0, 0, this.els.panels[0]); }

  /* ---------- gameplay ---------- */
  _tap(p, panel, pi) {
    // screen -> content percent coords
    const size = panel.getBoundingClientRect().width;
    const cx = (p.x - this.zoom.tx) / this.zoom.s / size * 100;
    const cy = (p.y - this.zoom.ty) / this.zoom.s / size * 100;

    let best = null, bestD = Infinity;
    this.puzzle.regions.forEach((r, i) => {
      if (this.found.has(i)) return;
      const eff = Math.max(r.radius, 4.5) * 1.2;
      const d = Math.hypot(r.x - cx, r.y - cy);
      if (d <= eff && d < bestD) { bestD = d; best = i; }
    });

    if (best != null) this._hit(best);
    else this._miss(cx, cy);
  }

  _hit(i) {
    this.found.add(i);
    const r = this.puzzle.regions[i];
    this.els.inners.forEach(inner => {
      const m = document.createElement('div');
      m.className = 'marker';
      m.style.left = `${r.x}%`; m.style.top = `${r.y}%`;
      m.textContent = this.found.size;
      inner.appendChild(m);
    });
    this.timeLeft = Math.min(this.totalTime, this.timeLeft + 4);
    sfx.found(); vibrate(30);
    this.cb.onProgress(this.found.size, this.puzzle.count);
    if (this.found.size >= this.puzzle.count) this._win();
  }

  _miss(cx, cy) {
    this.misses++;
    this.timeLeft -= 6;
    sfx.miss(); vibrate([60, 40, 60]);
    this.els.inners.forEach(inner => {
      const x = document.createElement('div');
      x.className = 'miss-x';
      x.style.left = `${cx}%`; x.style.top = `${cy}%`;
      x.textContent = '✕';
      inner.appendChild(x);
      setTimeout(() => x.remove(), 700);
    });
    document.body.classList.add('flash-miss');
    setTimeout(() => document.body.classList.remove('flash-miss'), 260);
    if (this.timeLeft <= 0) this._lose();
  }

  // rewarded-ad refill: re-arm the single hint slot and fire it
  rewardHint() {
    this.hintsUsed = 0;
    return this.hint();
  }

  hint() {
    if (this.hintsUsed >= 1 || this.finished || !this.running) return false;
    const unfound = this.puzzle.regions.map((_, i) => i).filter(i => !this.found.has(i));
    if (!unfound.length) return false;
    this.hintsUsed++;
    const r = this.puzzle.regions[unfound[(Math.random() * unfound.length) | 0]];
    sfx.hint();
    this.els.inners.forEach(inner => {
      const ring = document.createElement('div');
      ring.className = 'hint-ring';
      ring.style.left = `${r.x}%`; ring.style.top = `${r.y}%`;
      ring.style.width = ring.style.height = `${Math.max(r.radius, 5) * 2.6}%`;
      inner.appendChild(ring);
      setTimeout(() => ring.remove(), 1800);
    });
    return true;
  }

  _win() {
    this.finished = true; this.running = false;
    sfx.win(); vibrate([40, 60, 40, 60, 120]);
    const stars = (this.misses === 0 && this.hintsUsed === 0) ? 3 : (this.misses <= 2 ? 2 : 1);
    setTimeout(() => this.cb.onWin({
      stars,
      misses: this.misses,
      hintsUsed: this.hintsUsed,
      timeUsed: Math.max(1, Math.round(this.elapsed)),
    }), 550);
  }

  _lose() {
    if (this.finished) return;
    this.finished = true; this.running = false;
    cancelAnimationFrame(this._raf);
    this.timeLeft = 0;
    this._renderTimer();
    sfx.lose(); vibrate(300);
    setTimeout(() => this.cb.onLose({ found: this.found.size, total: this.puzzle.count }), 500);
  }
}
