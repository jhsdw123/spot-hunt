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
let flags = null;

export function roundBegin(round) {
  flags = { first: false, hint: false };
  // wait for the countdown to finish, then hold the round for the intro
  const iv = setInterval(() => {
    if (round.destroyed) { clearInterval(iv); return; }
    if (!round.running) return;
    clearInterval(iv);
    pauseFor(round, {
      targets: [$('.panels')],
      html: `Find all <b>${round.puzzle.count} differences</b> between the two pictures — tap them in <b>either</b> picture! 🔍<br><span class="dim">Pinch or scroll to zoom in.</span>`,
      next: `Let's go!`,
    });
  }, 120);
}

export function roundProgress(round, found, total) {
  if (!flags || round.finished) return;
  if (found === 1 && !flags.first) {
    flags.first = true;
    pauseFor(round, {
      targets: [$('#timer-text')],
      html: `Nice one! ✅ Every find adds <b>+4s</b> to the clock. Careless taps cost <b>−6s</b> — aim well!`,
      next: 'Got it',
    });
  } else if (found === total - 1 && !flags.hint) {
    flags.hint = true;
    pauseFor(round, {
      targets: [$('#btn-hint')],
      html: `One to go! Stuck? Tap <b>💡</b> — both pictures flash on top of each other for a moment, so the difference <i>pops</i>. <b>You get one per game!</b>`,
      next: 'Got it',
    });
  }
}

export function roundEnd() { flags = null; }

async function pauseFor(round, step) {
  round._pause();
  await coach(step);
  if (!round.destroyed && !round.finished) round._resume();
}
