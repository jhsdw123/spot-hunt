// Screen flow, persistence, and UI glue.
import { loadPuzzles, levelSequence, poolSize } from './data.js';
import { Round } from './game.js';
import { sfx, toggleMute, isMuted, vibrate } from './audio.js';
import { confetti } from './confetti.js';
import * as versus from './versus.js';

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];

const state = {
  mode: localStorage.getItem('sh_mode') || 'toon',
  sequence: [],
  round: null,
  puzzle: null,
  stats: JSON.parse(localStorage.getItem('sh_stats') || '{"solved":0,"found":0,"stars3":0}'),
};

const levelKey = () => `sh_level_${state.mode}`;
const getLevel = () => parseInt(localStorage.getItem(levelKey()) || '0', 10);
const setLevel = v => localStorage.setItem(levelKey(), String(v));
const saveStats = () => localStorage.setItem('sh_stats', JSON.stringify(state.stats));

/* ---------- screens ---------- */
function show(screen) {
  $$('.screen').forEach(s => s.classList.remove('active'));
  $(`#screen-${screen}`).classList.add('active');
}

function updateHome() {
  const lvl = getLevel();
  const total = state.sequence.length;
  $('#home-level').textContent = `Level ${Math.min(lvl + 1, total)}`;
  $('#home-pool').textContent = `${total} puzzles`;
  $('#stat-solved').textContent = state.stats.solved;
  $('#stat-found').textContent = state.stats.found;
  $('#stat-stars').textContent = state.stats.stars3;
  $$('.chip').forEach(c => c.classList.toggle('active', c.dataset.mode === state.mode));
}

/* ---------- round flow ---------- */
async function startLevel() {
  const lvl = getLevel() % state.sequence.length;
  state.puzzle = state.sequence[lvl];
  show('game');
  $('#game-level').textContent = `Level ${lvl + 1}`;
  $('#found-count').textContent = `0/${state.puzzle.count}`;
  renderDots(0, state.puzzle.count);
  $('#btn-hint').classList.remove('used');

  // load both images, covered by the countdown veil
  $('#veil').classList.add('on');
  $('#veil-num').textContent = '';
  const [a, b] = [$('#img-a'), $('#img-b')];
  await Promise.all([setImg(a, state.puzzle.aUrl), setImg(b, state.puzzle.bUrl)]);

  state.round?.destroy();
  state.round = new Round(state.puzzle, {
    panels: [$('#panel-a'), $('#panel-b')],
    inners: [$('#inner-a'), $('#inner-b')],
    timerBar: $('#timer-bar'),
    timerText: $('#timer-text'),
  }, { onProgress, onWin, onLose });
  state.round.resetZoom();

  // 3-2-1 countdown, then reveal
  for (const n of [3, 2, 1]) {
    $('#veil-num').textContent = n;
    $('#veil-num').classList.remove('pop'); void $('#veil-num').offsetWidth;
    $('#veil-num').classList.add('pop');
    sfx.click();
    await sleep(620);
  }
  $('#veil').classList.remove('on');
  state.round.start();
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const setImg = (img, src) => new Promise((res, rej) => {
  if (img.src === src && img.complete) return res();
  img.onload = res; img.onerror = rej; img.src = src;
});

function renderDots(found, total) {
  $('#found-dots').innerHTML = Array.from({ length: total }, (_, i) =>
    `<span class="dot${i < found ? ' on' : ''}"></span>`).join('');
}

function onProgress(found, total) {
  $('#found-count').textContent = `${found}/${total}`;
  renderDots(found, total);
}

function onWin({ stars, misses, timeUsed }) {
  state.stats.solved++;
  state.stats.found += state.puzzle.count;
  if (stars === 3) state.stats.stars3++;
  saveStats();
  setLevel(getLevel() + 1);
  confetti();
  $('#result-title').textContent = ['Nice!', 'Great job!', 'Perfect!'][stars - 1];
  $('#result-sub').textContent = `${state.puzzle.count} differences · ${timeUsed}s · ${misses} miss${misses === 1 ? '' : 'es'}`;
  $$('#result-stars span').forEach((s, i) => {
    s.classList.remove('on', 'pop');
    if (i < stars) setTimeout(() => s.classList.add('on', 'pop'), 250 + i * 220);
  });
  $('#result-fail').style.display = 'none';
  $('#btn-next').textContent = 'Next puzzle  →';
  $('#result').classList.add('on');
}

function onLose({ found, total }) {
  $('#result-title').textContent = "Time's up!";
  $('#result-sub').textContent = `You found ${found} of ${total} differences`;
  $$('#result-stars span').forEach(s => s.classList.remove('on', 'pop'));
  $('#result-fail').style.display = '';
  $('#btn-next').textContent = 'Try again  ↻';
  $('#result').classList.add('on');
}

function closeResult() { $('#result').classList.remove('on'); }

/* ---------- events ---------- */
function bind() {
  $('#btn-play').addEventListener('click', () => { sfx.click(); startLevel(); });

  $$('.chip').forEach(c => c.addEventListener('click', () => {
    sfx.click();
    state.mode = c.dataset.mode;
    localStorage.setItem('sh_mode', state.mode);
    state.sequence = levelSequence(state.mode);
    updateHome();
  }));

  $('#btn-back').addEventListener('click', () => {
    sfx.click();
    if (versus.isActive()) { versus.leave(); updateHome(); return; }
    state.round?.destroy(); state.round = null;
    closeResult();
    updateHome();
    show('home');
  });

  $('#btn-hint').addEventListener('click', () => {
    if (state.round?.hint()) $('#btn-hint').classList.add('used');
  });

  $('#btn-zoom-reset').addEventListener('click', () => {
    sfx.click();
    (state.round || versus.currentRound())?.resetZoom();
  });

  const muteBtns = ['#btn-mute', '#btn-mute-game'];
  const renderMute = () => muteBtns.forEach(sel => { const b = $(sel); if (b) b.textContent = isMuted() ? '🔇' : '🔊'; });
  muteBtns.forEach(sel => $(sel)?.addEventListener('click', () => { toggleMute(); renderMute(); }));
  renderMute();

  $('#btn-next').addEventListener('click', () => {
    sfx.click();
    if (versus.isActive()) { versus.nextAction(); return; }
    closeResult(); startLevel();
  });
  $('#btn-result-home').addEventListener('click', () => {
    sfx.click();
    if (versus.isActive()) { versus.leave(); updateHome(); return; }
    closeResult();
    state.round?.destroy(); state.round = null;
    updateHome(); show('home');
  });

  versus.bind();

  $('#btn-share')?.addEventListener('click', async () => {
    const text = `Spot Hunt 🔍 — I've solved ${state.stats.solved} puzzles! Can you beat me?`;
    try {
      if (navigator.share) await navigator.share({ text, url: location.href });
      else { await navigator.clipboard.writeText(text + ' ' + location.href); sfx.found(); }
    } catch {}
  });

  // custom PWA install prompt
  let deferred = null;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault(); deferred = e;
    $('#btn-install').style.display = '';
  });
  $('#btn-install').addEventListener('click', async () => {
    if (!deferred) return;
    deferred.prompt();
    await deferred.userChoice;
    deferred = null;
    $('#btn-install').style.display = 'none';
  });
}

/* ---------- boot ---------- */
(async function init() {
  bind();
  try {
    await loadPuzzles();
  } catch (e) {
    $('#home-pool').textContent = 'offline — check connection';
  }
  state.sequence = levelSequence(state.mode);
  updateHome();
  show('home');
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  // expose for E2E tests
  window.__sh = { state, startLevel, versus };
})();
