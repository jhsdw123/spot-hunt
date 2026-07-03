// Versus mode — 2-player race over Supabase Realtime (broadcast + presence).
// Both players solve the same puzzles on independent boards; live progress is mirrored.
// Round winner: complete beats incomplete; both complete -> faster; both incomplete -> more found.
import { loadPuzzles } from './data.js';
import { Round } from './game.js';
import { sfx, vibrate } from './audio.js';
import { confetti } from './confetti.js';
import { SUPABASE_URL, SUPABASE_ANON } from './config.js';

const ROUNDS = 3;
const CODE_ALPHabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const setImg = (img, src) => new Promise((res, rej) => {
  if (img.src === src && img.complete) return res();
  img.onload = res; img.onerror = rej; img.src = src;
});

const vs = {
  sb: null, channel: null, code: '', isHost: false,
  myId: Math.random().toString(36).slice(2, 10),
  myName: localStorage.getItem('sh_name') || '',
  oppName: '', oppHere: false,
  style: 'toon',
  puzzles: [], roundIdx: 0,
  score: { me: 0, opp: 0 },
  round: null, myResult: null, oppResult: null, oppReady: false, myReady: false,
  active: false, inRound: false,
  readyTimer: null, resultTimer: null,
};

function clearTimers() {
  clearInterval(vs.readyTimer); vs.readyTimer = null;
  clearInterval(vs.resultTimer); vs.resultTimer = null;
}

export function isActive() { return vs.active; }
export function currentRound() { return vs.round; }
export function __presence() { return vs.channel ? vs.channel.presenceState() : null; }

function client() {
  if (!vs.sb) vs.sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON, {
    realtime: { params: { eventsPerSecond: 10 } },
  });
  return vs.sb;
}

/* ---------- screens/steps ---------- */
function show(screen) {
  $$('.screen').forEach(s => s.classList.remove('active'));
  $(`#screen-${screen}`).classList.add('active');
}
function step(name) {
  $$('#screen-versus .vs-step').forEach(s => s.classList.toggle('on', s.dataset.step === name));
}
function setStatus(text) { $('#vs-status').textContent = text; }

/* ---------- lobby ---------- */
export function open() {
  vs.active = false;
  $('#vs-name').value = vs.myName;
  $('#vs-code-input').value = '';
  step('entry');
  show('versus');
}

function saveName() {
  vs.myName = ($('#vs-name').value.trim() || 'Player').slice(0, 12);
  localStorage.setItem('sh_name', vs.myName);
}

function makeCode() {
  return Array.from({ length: 4 }, () => CODE_ALPHabet[(Math.random() * CODE_ALPHabet.length) | 0]).join('');
}

async function createRoom() {
  saveName();
  vs.isHost = true;
  vs.code = makeCode();
  await joinChannel();
  $('#vs-code-big').textContent = vs.code;
  $('#vs-start').disabled = true;
  setStatus('Waiting for your friend…');
  step('host');
}

async function joinRoom() {
  saveName();
  const code = $('#vs-code-input').value.trim().toUpperCase();
  if (code.length !== 4) { setEntryMsg('Enter the 4-letter room code'); return; }
  vs.isHost = false;
  vs.code = code;
  await joinChannel();
  // wait for presence sync to reveal the host (arrival timing varies)
  let others = [];
  for (let i = 0; i < 20 && !others.length; i++) {
    await sleep(300);
    others = othersInRoom();
  }
  if (!others.length) {
    setEntryMsg('Room not found — check the code');
    await leaveChannel();
    return;
  }
  if (others.length >= 2) {
    setEntryMsg('Room is full');
    await leaveChannel();
    return;
  }
  $('#vs-code-guest').textContent = vs.code;
  setStatus('Waiting for the host to start…');
  step('guest');
}

function setEntryMsg(t) { $('#vs-entry-msg').textContent = t; }

function othersInRoom() {
  const state = vs.channel?.presenceState() || {};
  return Object.entries(state).filter(([k]) => k !== vs.myId).map(([, v]) => v[0]);
}

async function joinChannel() {
  const ch = client().channel(`sh-room-${vs.code}`, {
    config: { broadcast: { self: false }, presence: { key: vs.myId } },
  });
  vs.channel = ch;

  ch.on('presence', { event: 'sync' }, onPresence);
  ch.on('broadcast', { event: 'start_match' }, ({ payload }) => onStartMatch(payload));
  ch.on('broadcast', { event: 'ready' }, ({ payload }) => onOppReady(payload));
  ch.on('broadcast', { event: 'go' }, ({ payload }) => onGo(payload));
  ch.on('broadcast', { event: 'progress' }, ({ payload }) => onOppProgress(payload));
  ch.on('broadcast', { event: 'round_done' }, ({ payload }) => onOppRoundDone(payload));

  await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('connection timeout')), 8000);
    ch.subscribe(status => {
      if (status === 'SUBSCRIBED') { clearTimeout(t); res(); }
      if (status === 'CHANNEL_ERROR') { clearTimeout(t); rej(new Error('channel error')); }
    });
  });
  await ch.track({ name: vs.myName, host: vs.isHost });
}

async function leaveChannel() {
  try { await vs.channel?.unsubscribe(); } catch {}
  vs.channel = null;
}

function onPresence() {
  const others = othersInRoom();
  const opp = others[0];
  const wasHere = vs.oppHere;
  vs.oppHere = !!opp;
  if (opp) vs.oppName = opp.name || 'Friend';

  if (vs.isHost && !vs.active) {
    $('#vs-start').disabled = !vs.oppHere;
    setStatus(vs.oppHere ? `${vs.oppName} joined — ready when you are!` : 'Waiting for your friend…');
    if (vs.oppHere && !wasHere) sfx.found();
  }
  // opponent left mid-match
  if (vs.active && wasHere && !vs.oppHere) {
    endMatchAbrupt(`${vs.oppName || 'Your friend'} left the game`);
  }
}

/* ---------- match flow ---------- */
function pickPuzzles(all, style) {
  const pool = all.filter(e => style === 'mixed' ? true : e.style === style);
  const ids = new Set();
  while (ids.size < Math.min(ROUNDS, pool.length)) ids.add(pool[(Math.random() * pool.length) | 0].id);
  return [...ids];
}

async function hostStart() {
  const all = await loadPuzzles();
  const ids = pickPuzzles(all, vs.style);
  vs.channel.send({ type: 'broadcast', event: 'start_match', payload: { ids, style: vs.style } });
  await onStartMatch({ ids, style: vs.style });
}

async function onStartMatch({ ids }) {
  const all = await loadPuzzles();
  vs.puzzles = ids.map(id => all.find(e => e.id === id)).filter(Boolean);
  vs.roundIdx = 0;
  vs.score = { me: 0, opp: 0 };
  vs.active = true;
  document.body.classList.add('versus');
  beginRound();
}

async function beginRound() {
  const puzzle = vs.puzzles[vs.roundIdx];
  vs.myResult = null; vs.oppResult = null; vs.myReady = false; vs.oppReady = false;
  vs.inRound = true;

  show('game');
  $('#game-level').textContent = `Round ${vs.roundIdx + 1}/${ROUNDS}`;
  $('#found-count').textContent = `0/${puzzle.count}`;
  renderDots(0, puzzle.count);
  renderOpp(0, puzzle.count);
  renderMatchScore();
  $('#veil').classList.add('on');
  $('#veil-num').textContent = '…';

  await Promise.all([setImg($('#img-a'), puzzle.aUrl), setImg($('#img-b'), puzzle.bUrl)]);

  vs.round?.destroy();
  vs.round = new Round(puzzle, {
    panels: [$('#panel-a'), $('#panel-b')],
    inners: [$('#inner-a'), $('#inner-b')],
    timerBar: $('#timer-bar'),
    timerText: $('#timer-text'),
  }, {
    onProgress: (found, total) => {
      $('#found-count').textContent = `${found}/${total}`;
      renderDots(found, total);
      vs.channel?.send({ type: 'broadcast', event: 'progress', payload: { round: vs.roundIdx, found } });
    },
    onWin: ({ timeUsed }) => myRoundDone({ complete: true, found: puzzle.count, elapsed: vs.round.elapsed }),
    onLose: ({ found }) => myRoundDone({ complete: false, found, elapsed: vs.round.elapsed }),
  });
  vs.round.resetZoom();

  // ready handshake so a slow connection never starts late; re-send until the
  // round actually starts (broadcasts are fire-and-forget and can be missed
  // while the peer is still on the previous round)
  vs.myReady = true;
  const sendReady = () => vs.channel?.send({ type: 'broadcast', event: 'ready', payload: { round: vs.roundIdx } });
  sendReady();
  clearInterval(vs.readyTimer);
  vs.readyTimer = setInterval(() => {
    if (!vs.inRound || vs.round?.running) { clearInterval(vs.readyTimer); return; }
    sendReady();
  }, 1200);
  maybeGo();
}

function onOppReady({ round }) {
  if (round !== vs.roundIdx) return;
  vs.oppReady = true;
  maybeGo();
}

function maybeGo() {
  if (vs.isHost && vs.myReady && vs.oppReady) {
    vs.channel.send({ type: 'broadcast', event: 'go', payload: { round: vs.roundIdx } });
    onGo({ round: vs.roundIdx });
  }
}

async function onGo({ round }) {
  if (round !== vs.roundIdx || !vs.inRound || vs.round?.running || vs._counting) return;
  vs._counting = true;
  clearInterval(vs.readyTimer);
  for (const n of [3, 2, 1]) {
    $('#veil-num').textContent = n;
    $('#veil-num').classList.remove('pop'); void $('#veil-num').offsetWidth;
    $('#veil-num').classList.add('pop');
    sfx.click();
    await sleep(620);
  }
  $('#veil').classList.remove('on');
  vs._counting = false;
  vs.round.start();
}

function onOppProgress({ round, found }) {
  if (round !== vs.roundIdx) return;
  renderOpp(found, vs.puzzles[vs.roundIdx].count);
}

function myRoundDone(result) {
  if (vs.myResult) return;
  vs.myResult = result;
  const send = () => vs.channel?.send({ type: 'broadcast', event: 'round_done', payload: { round: vs.roundIdx, ...result } });
  send();
  clearInterval(vs.resultTimer);
  vs.resultTimer = setInterval(() => { if (vs.oppResult || !vs.active) clearInterval(vs.resultTimer); else send(); }, 1500);
  maybeSettle();
}

function onOppRoundDone(payload) {
  if (payload.round !== vs.roundIdx) return;
  vs.oppResult = payload;
  renderOpp(payload.found, vs.puzzles[vs.roundIdx].count);
  // opponent finished everything while I'm still hunting -> round over for me too
  if (payload.complete && !vs.myResult && vs.round && !vs.round.finished) {
    vs.round.halt();
    myRoundDone({ complete: false, found: vs.round.found.size, elapsed: vs.round.elapsed });
    return;
  }
  maybeSettle();
}

function maybeSettle() {
  if (!vs.myResult || !vs.oppResult || !vs.inRound) return;
  vs.inRound = false;
  clearTimers();
  const me = vs.myResult, op = vs.oppResult;
  let outcome; // 1 win, -1 lose, 0 draw
  if (me.complete !== op.complete) outcome = me.complete ? 1 : -1;
  else if (me.complete) outcome = me.elapsed === op.elapsed ? 0 : (me.elapsed < op.elapsed ? 1 : -1);
  else outcome = me.found === op.found ? 0 : (me.found > op.found ? 1 : -1);

  if (outcome === 1) vs.score.me++;
  if (outcome === -1) vs.score.opp++;
  showRoundResult(outcome);
}

async function showRoundResult(outcome) {
  const last = vs.roundIdx >= ROUNDS - 1;
  renderMatchScore();
  if (outcome === 1) { sfx.win(); vibrate([40, 60, 80]); }
  else if (outcome === -1) sfx.lose();

  $('#result-fail').style.display = 'none';
  $$('#result-stars span').forEach(s => s.classList.remove('on', 'pop'));
  $('#result-title').textContent = outcome === 1 ? 'Round won! 🎉' : outcome === -1 ? 'Round lost' : 'Draw!';
  $('#result-sub').textContent =
    `You ${vs.myResult.found}/${vs.puzzles[vs.roundIdx].count} · ${vs.oppName} ${vs.oppResult.found}/${vs.puzzles[vs.roundIdx].count}   —   ${vs.myName} ${vs.score.me} : ${vs.score.opp} ${vs.oppName}`;
  $('#btn-next').style.display = 'none';
  $('#btn-result-home').style.display = 'none';
  $('#result').classList.add('on');

  await sleep(3400);
  $('#result').classList.remove('on');
  $('#btn-next').style.display = '';
  $('#btn-result-home').style.display = '';

  if (!last) {
    vs.roundIdx++;
    beginRound();
  } else {
    showMatchResult();
  }
}

function showMatchResult() {
  const won = vs.score.me > vs.score.opp;
  const draw = vs.score.me === vs.score.opp;
  if (won) { confetti(); sfx.win(); }
  $('#result-fail').style.display = 'none';
  $$('#result-stars span').forEach((s, i) => {
    s.classList.remove('on', 'pop');
    if (won) setTimeout(() => s.classList.add('on', 'pop'), 250 + i * 220);
  });
  $('#result-title').textContent = draw ? "It's a draw!" : won ? 'You win the match! 🏆' : `${vs.oppName} wins!`;
  $('#result-sub').textContent = `Final score  ${vs.myName} ${vs.score.me} : ${vs.score.opp} ${vs.oppName}`;
  $('#btn-next').textContent = vs.isHost ? 'Rematch ↻' : 'Waiting for host…';
  $('#btn-next').disabled = !vs.isHost;
  $('#result').classList.add('on');
  vs.matchOver = true;
}

export async function nextAction() {
  // called by main.js when #btn-next is pressed while versus is active
  if (vs.matchOver && vs.isHost) {
    vs.matchOver = false;
    $('#result').classList.remove('on');
    $('#btn-next').disabled = false;
    await hostStart();
  }
}

function endMatchAbrupt(msg) {
  clearTimers();
  vs.round?.destroy(); vs.round = null;
  vs.active = false; vs.inRound = false;
  document.body.classList.remove('versus');
  $('#result').classList.remove('on');
  alert(msg);
  leave();
}

export async function leave() {
  clearTimers();
  vs.round?.destroy(); vs.round = null;
  vs.active = false; vs.inRound = false; vs.matchOver = false;
  vs.oppHere = false;
  document.body.classList.remove('versus');
  $('#result').classList.remove('on');
  $('#btn-next').disabled = false;
  $('#btn-next').style.display = '';
  $('#btn-result-home').style.display = '';
  await leaveChannel();
  show('home');
}

/* ---------- render helpers ---------- */
function renderDots(found, total) {
  $('#found-dots').innerHTML = Array.from({ length: total }, (_, i) =>
    `<span class="dot${i < found ? ' on' : ''}"></span>`).join('');
}
function renderOpp(found, total) {
  $('#opp-name').textContent = vs.oppName || 'Friend';
  $('#opp-count').textContent = `${found}/${total}`;
  $('#opp-dots').innerHTML = Array.from({ length: total }, (_, i) =>
    `<span class="dot opp${i < found ? ' on' : ''}"></span>`).join('');
}
function renderMatchScore() {
  $('#vs-scoreline').textContent = `${vs.score.me} : ${vs.score.opp}`;
}

/* ---------- bindings ---------- */
export function bind() {
  $('#btn-versus').addEventListener('click', () => { sfx.click(); open(); });
  $('#vs-create').addEventListener('click', () => { sfx.click(); setEntryMsg(''); createRoom().catch(e => setEntryMsg(e.message)); });
  $('#vs-join').addEventListener('click', () => { sfx.click(); setEntryMsg(''); joinRoom().catch(e => setEntryMsg(e.message)); });
  $('#vs-back').addEventListener('click', async () => { sfx.click(); await leaveChannel(); show('home'); });
  $('#vs-leave-host').addEventListener('click', async () => { sfx.click(); await leaveChannel(); step('entry'); });
  $('#vs-leave-guest').addEventListener('click', async () => { sfx.click(); await leaveChannel(); step('entry'); });
  $('#vs-start').addEventListener('click', () => { sfx.click(); hostStart(); });
  $$('#vs-modes .chip').forEach(c => c.addEventListener('click', () => {
    vs.style = c.dataset.vsMode;
    $$('#vs-modes .chip').forEach(x => x.classList.toggle('active', x === c));
  }));
  $('#vs-code-input').addEventListener('input', e => { e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4); });
}
