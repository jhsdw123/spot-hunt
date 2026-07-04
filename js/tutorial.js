// First-run onboarding — spotlight coach marks over the real buttons, then a
// guided first puzzle with explainer bubbles (timer pauses while they're up).
// Re-runnable any time from the ❓ button on the home screen.
import { storeGet, storeSet } from './store.js';

const $ = s => document.querySelector(s);

export function tourNeeded() { return storeGet('sh_tour') !== '1'; }
const markSeen = () => storeSet('sh_tour', '1');

function rectUnion(els) {
  const rs = els.filter(Boolean).map(e => e.getBoundingClientRect());
  if (!rs.length) return null;
  const left = Math.min(...rs.map(r => r.left)), top = Math.min(...rs.map(r => r.top));
  return {
    left, top,
    width: Math.max(...rs.map(r => r.right)) - left,
    height: Math.max(...rs.map(r => r.bottom)) - top,
  };
}

// one spotlight step; resolves with 'next' or 'skip'
function coach({ targets, html, next = 'Next →', skip = null }) {
  return new Promise(res => {
    const r = targets ? rectUnion(targets) : null;
    const pad = 10;
    const wrap = document.createElement('div');
    wrap.id = 'tour';
    const below = !r || r.top + r.height / 2 < innerHeight * 0.52;
    wrap.innerHTML = `
      <div class="tour-spot${r ? '' : ' free'}"></div>
      <div class="tour-bubble">
        ${r ? `<div class="tour-arrow${below ? '' : ' down'}">${below ? '☝️' : '👇'}</div>` : ''}
        <div class="tour-text">${html}</div>
        <div class="tour-btns">
          ${skip ? `<button class="ghost-btn" data-act="skip">${skip}</button>` : ''}
          <button class="play-btn small" data-act="next"><span class="play-main">${next}</span></button>
        </div>
      </div>`;
    const spot = wrap.querySelector('.tour-spot');
    if (r) {
      spot.style.left = `${r.left - pad}px`;
      spot.style.top = `${r.top - pad}px`;
      spot.style.width = `${r.width + pad * 2}px`;
      spot.style.height = `${r.height + pad * 2}px`;
    }
    document.body.appendChild(wrap);
    const bubble = wrap.querySelector('.tour-bubble');
    const bh = bubble.getBoundingClientRect().height;
    let top = !r ? innerHeight / 2 - bh / 2
      : below ? r.top + r.height + pad + 16
      : r.top - pad - 16 - bh;
    bubble.style.top = `${Math.max(12, Math.min(top, innerHeight - bh - 12))}px`;
    // the tap that TRIGGERED this bubble fires a delayed synthetic click that
    // can land on our buttons — ignore clicks until the bubble has settled
    const armedAt = performance.now() + 350;
    wrap.querySelectorAll('.tour-btns button').forEach(b =>
      b.addEventListener('click', () => {
        if (performance.now() < armedAt) return;
        wrap.remove(); res(b.dataset.act);
      }));
  });
}

/* ---------- home-screen tour ---------- */
// returns true when the user chose to play the tutorial puzzle
export async function homeTour() {
  const s1 = await coach({
    targets: [$('#screen-home .chips'), $('#btn-play')],
    html: `<b>Playing solo</b><br>Pick a puzzle style — 🖍️ Cartoon, 📷 Photo or 🎲 Mixed — then hit <b>PLAY</b>!`,
    skip: 'Skip tour',
  });
  if (s1 === 'skip') { markSeen(); return false; }
  const s2 = await coach({
    targets: [$('#btn-versus')],
    html: `<b>Playing with friends</b><br>Tap <b>⚔️ Versus</b> and create a room — friends join by typing your <b>4-letter room code</b>. Up to 8 players, 3 rounds, live race!`,
    skip: 'Skip',
  });
  markSeen();
  if (s2 === 'skip') return false;
  const s3 = await coach({
    targets: null,
    html: `<b>Ready?</b><br>The best way to learn is to play — let's try your first puzzle together!`,
    next: '▶ Start tutorial',
    skip: 'Maybe later',
  });
  return s3 === 'next';
}

/* ---------- guided first puzzle ---------- */
// fixed pair: clean-lined bear-picnic cartoon, 5 unambiguous differences,
// regions hand-verified by the author (Flow AI batch — not auto-detected)
export const TUTORIAL_ID = 'sd_mr4rwrru_loz3';

let t = null; // { step, hintShown, idleTimer }

export function roundBegin(round) {
  t = { step: 'wait', hintShown: false, idleTimer: null };
  // wait for the 3-2-1 countdown to finish, then freeze the clock and teach
  const iv = setInterval(() => {
    if (round.destroyed) { clearInterval(iv); return; }
    if (!round.running) return;
    clearInterval(iv);
    round.freezeTime(true);
    t.step = 'demo';
    showTip(`Let's find all <b>${round.puzzle.count} differences</b>! They look like this — <b>tap the circled spot</b> in either picture 👆`);
    maskRegion(round, nextUnfound(round));
  }, 120);
}

export function roundProgress(round, found, total) {
  if (!t || round.finished) return;
  if (t.step === 'demo' && found < 2) {
    // first find: celebrate, then point at the second answer
    showTip(`Perfect! 🎉 That's a difference. Here's one more — <b>tap it!</b>`);
    maskRegion(round, nextUnfound(round));
  } else if (t.step === 'demo') {
    clearMask();
    hideTip();
    t.step = 'progress';
    (async () => {
      await coach({
        targets: [$('#found-count'), $('#found-dots')],
        html: `Your progress lives up here — <b>${found} of ${total}</b> found. Fill every dot to win! ✅`,
        next: 'Got it',
      });
      if (round.destroyed || round.finished) return;
      t.step = 'free';
      round.freezeTime(false);
      showTip(`Now find the last <b>${total - found}</b> on your own! Every find adds <b>+4s</b> — misses cost <b>−6s</b>. 🔍 Pinch or scroll to zoom.`, 5000);
      armIdleHint(round);
    })();
  } else if (t.step === 'free') {
    armIdleHint(round); // finding something resets the "stuck" timer
    if (found === total - 1) hintLesson(round);
  }
}

export function roundEnd() {
  clearTimeout(t?.idleTimer);
  t = null;
  hideTip();
  clearMask();
}

// teach the hint when they're stuck (12s without a find) or one from the end
function armIdleHint(round) {
  if (!t) return;
  clearTimeout(t.idleTimer);
  if (t.hintShown) return;
  t.idleTimer = setTimeout(() => hintLesson(round), 12000);
}

async function hintLesson(round) {
  if (!t || t.hintShown || round.finished) return;
  t.hintShown = true;
  clearTimeout(t.idleTimer);
  round._pause();
  await coach({
    targets: [$('#btn-hint')],
    html: `Can't spot one? Tap <b>HINT</b> — the clock freezes, you get a <b>3·2·1</b> heads-up, then the two pictures flash <b>A·B·A·B</b> super fast so the difference jumps right out. <b>Once per game!</b>`,
    next: 'Got it',
  });
  if (!round.destroyed && !round.finished) round._resume();
}

/* ---- tutorial visuals: answer mask + tip bar ---- */
const SVG_NS = 'http://www.w3.org/2000/svg';

function nextUnfound(round) {
  return round.puzzle.regions.findIndex((_, i) => !round.found.has(i));
}

// grey out everything except a pulsing ring around the answer, in both panels
function maskRegion(round, idx) {
  const r = round.puzzle.regions[idx];
  if (!r) return;
  const rad = Math.max(r.radius, 4.5) * 1.6;
  round.els.inners.forEach(inner => {
    let svg = inner.querySelector('.tut-mask');
    if (!svg) {
      svg = document.createElementNS(SVG_NS, 'svg');
      svg.setAttribute('class', 'tut-mask');
      svg.setAttribute('viewBox', '0 0 100 100');
      svg.setAttribute('preserveAspectRatio', 'none');
      inner.appendChild(svg);
    }
    svg.innerHTML = `
      <path fill="rgba(5,6,15,0.62)" fill-rule="evenodd"
        d="M0 0 H100 V100 H0 Z M${r.x - rad} ${r.y} a${rad} ${rad} 0 1 0 ${rad * 2} 0 a${rad} ${rad} 0 1 0 ${-rad * 2} 0"/>
      <circle class="tut-ring" cx="${r.x}" cy="${r.y}" r="${rad}" fill="none"/>`;
  });
}

function clearMask() {
  document.querySelectorAll('.tut-mask').forEach(m => m.remove());
}

let tipTimer = null;
function showTip(html, autoHide = 0) {
  let el = $('#tut-tip');
  if (!el) {
    el = document.createElement('div');
    el.id = 'tut-tip';
    $('#screen-game').appendChild(el);
  }
  el.innerHTML = html;
  el.classList.add('on');
  clearTimeout(tipTimer);
  if (autoHide) tipTimer = setTimeout(hideTip, autoHide);
}

function hideTip() { $('#tut-tip')?.classList.remove('on'); }
