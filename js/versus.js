// Versus mode — up to 8 players race over Supabase Realtime (broadcast + presence).
// Everyone solves the same puzzles on independent boards; live progress is mirrored.
// Round ranking: completers (by time) ahead of non-completers (by found count).
import { loadPuzzles } from './data.js';
import { Round } from './game.js';
import { sfx, vibrate } from './audio.js';
import { confetti } from './confetti.js';
import { SUPABASE_URL, SUPABASE_ANON } from './config.js';

const ROUNDS = 3;
const MAX_PLAYERS = 8;
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const setImg = (img, src) => new Promise((res, rej) => {
  if (img.src === src && img.complete) return res();
  img.onload = res; img.onerror = rej; img.src = src;
});
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const ordinal = n => n === 1 ? '1st' : n === 2 ? '2nd' : n === 3 ? '3rd' : `${n}th`;

const vs = {
  sb: null, channel: null, code: '', isHost: false,
  myId: Math.random().toString(36).slice(2, 10),
  myName: localStorage.getItem('sh_name') || '',
  style: 'toon',
  roster: [],            // fixed at match start: [{key, name}]
  leftKeys: new Set(),   // players who disconnected mid-match
  puzzles: [], roundIdx: 0,
  results: {},           // this round: key -> {found, complete, elapsed}
  tally: {},             // key -> {wins, found, elapsed}
  readySet: new Set(),
  round: null,
  active: false, inRound: false, matchOver: false,
  personalDone: false, hurryFired: false, _counting: false,
  readyTimer: null, resultTimer: null, settleTimer: null,
  chatLog: [], unread: 0, chatOpen: false,
};

export function isActive() { return vs.active; }
export function currentRound() { return vs.round; }
export function __presence() { return vs.channel ? vs.channel.presenceState() : null; }
export function __vs() { return vs; }

function clearTimers() {
  clearInterval(vs.readyTimer); vs.readyTimer = null;
  clearInterval(vs.resultTimer); vs.resultTimer = null;
  clearTimeout(vs.settleTimer); vs.settleTimer = null;
}

function client() {
  if (!vs.sb) vs.sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON, {
    realtime: { params: { eventsPerSecond: 10 } },
  });
  return vs.sb;
}

function send(event, payload) {
  vs.channel?.send({ type: 'broadcast', event, payload: { from: vs.myId, ...payload } });
}

/* ---------- screens/steps ---------- */
function show(screen) {
  $$('.screen').forEach(s => s.classList.remove('active'));
  $(`#screen-${screen}`).classList.add('active');
}
function step(name) {
  $$('#screen-versus .vs-step').forEach(s => s.classList.toggle('on', s.dataset.step === name));
  $('#screen-versus').classList.toggle('in-room', name !== 'entry');
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
  vs.myName = ($('#vs-name').value.trim() || 'Player' + ((Math.random() * 90 + 10) | 0)).slice(0, 12);
  localStorage.setItem('sh_name', vs.myName);
}

function makeCode() {
  return Array.from({ length: 4 }, () => CODE_ALPHABET[(Math.random() * CODE_ALPHABET.length) | 0]).join('');
}

async function createRoom() {
  saveName();
  vs.isHost = true;
  vs.code = makeCode();
  await joinChannel();
  $('#vs-code-big').textContent = vs.code;
  $('#vs-start').disabled = true;
  setStatus('Waiting for players…');
  step('host');
  renderLobby();
}

async function joinRoom() {
  saveName();
  const code = $('#vs-code-input').value.trim().toUpperCase();
  if (code.length !== 4) { setEntryMsg('Enter the 4-letter room code'); return; }
  vs.isHost = false;
  vs.code = code;
  await joinChannel();
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
  if (playersInRoom().length > MAX_PLAYERS) {
    setEntryMsg(`Room is full (max ${MAX_PLAYERS} players)`);
    await leaveChannel();
    return;
  }
  $('#vs-code-guest').textContent = vs.code;
  step('guest');
  renderLobby();
}

function setEntryMsg(t) { $('#vs-entry-msg').textContent = t; }

function playersInRoom() {
  const state = vs.channel?.presenceState() || {};
  return Object.entries(state).map(([key, metas]) => ({ key, name: metas[0]?.name || 'Player' }));
}
function othersInRoom() { return playersInRoom().filter(p => p.key !== vs.myId); }

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
  ch.on('broadcast', { event: 'chat' }, ({ payload }) => onChat(payload));

  await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('connection timeout')), 8000);
    ch.subscribe(status => {
      if (status === 'SUBSCRIBED') { clearTimeout(t); res(); }
      if (status === 'CHANNEL_ERROR') { clearTimeout(t); rej(new Error('channel error')); }
    });
  });
  await ch.track({ name: vs.myName });
}

async function leaveChannel() {
  try { await vs.channel?.unsubscribe(); } catch {}
  vs.channel = null;
  vs.chatLog = []; vs.unread = 0;
  setChatOpen(false);
  renderChat();
}

/* ---------- chat ---------- */
function pushChat(m) {
  vs.chatLog.push(m);
  if (vs.chatLog.length > 60) vs.chatLog.shift();
  renderChat();
}

function onChat({ from, name, text }) {
  if (typeof text !== 'string' || !text.trim()) return;
  const msg = { from, name: String(name || 'Player').slice(0, 12), text: String(text).slice(0, 120) };
  pushChat(msg);
  sfx.click();
  const inGame = $('#screen-game').classList.contains('active');
  if (inGame) {
    feedLine(msg);
    if (!vs.chatOpen) { vs.unread++; renderChatBadge(); }
  }
}

function sendChat(inputEl) {
  const text = inputEl.value.trim().slice(0, 120);
  if (!text || !vs.channel) return;
  inputEl.value = '';
  const msg = { from: vs.myId, name: vs.myName, text };
  pushChat(msg);
  if ($('#screen-game').classList.contains('active')) feedLine(msg);
  send('chat', { name: vs.myName, text });
}

function renderChat() {
  const html = vs.chatLog.map(m => `
    <div class="chat-m${m.from === vs.myId ? ' me' : ''}">
      <span class="chat-name">${esc(m.name)}</span>
      <span class="chat-text">${esc(m.text)}</span>
    </div>`).join('');
  for (const id of ['chat-msgs-lobby', 'chat-msgs-game']) {
    const box = document.getElementById(id);
    if (box) { box.innerHTML = html; box.scrollTop = box.scrollHeight; }
  }
}

function renderChatBadge() {
  const b = $('#chat-badge');
  if (!b) return;
  b.textContent = vs.unread > 9 ? '9+' : vs.unread;
  b.classList.toggle('on', vs.unread > 0);
}

function setChatOpen(open) {
  vs.chatOpen = open;
  $('#chat-panel')?.classList.toggle('on', open);
  if (open) {
    vs.unread = 0;
    renderChatBadge();
    renderChat();
  }
}

// live chat feed overlaid bottom-left on the puzzle images
function feedLine(msg) {
  const wrap = $('#chat-feed');
  if (!wrap) return;
  const t = document.createElement('div');
  t.className = 'feed-line' + (msg.from === vs.myId ? ' me' : '');
  t.innerHTML = `<b>${esc(msg.name)}</b>${esc(msg.text)}`;
  wrap.appendChild(t);
  while (wrap.children.length > 4) wrap.firstChild.remove();
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 400); }, 4800);
}

function renderLobby() {
  const players = playersInRoom();
  const rows = players.map(p =>
    `<div class="vs-player${p.key === vs.myId ? ' me' : ''}">👤 ${esc(p.name)}${p.key === vs.myId ? ' (you)' : ''}</div>`).join('');
  const html = `<div class="vs-player-list">${rows}</div>
    <div class="vs-player-count">${players.length}/${MAX_PLAYERS} players</div>`;
  const hostBox = $('#vs-players-host'), guestBox = $('#vs-players-guest');
  if (hostBox) hostBox.innerHTML = html;
  if (guestBox) guestBox.innerHTML = html;
}

function onPresence() {
  const players = playersInRoom();
  renderLobby();

  if (vs.isHost && !vs.active) {
    const n = players.length;
    $('#vs-start').disabled = n < 2;
    setStatus(n < 2 ? 'Waiting for players…' : `${n} players in — ready when you are!`);
  }

  if (vs.active) {
    // mark leavers; settle may now be possible
    const present = new Set(players.map(p => p.key));
    for (const p of vs.roster) {
      if (!present.has(p.key) && !vs.leftKeys.has(p.key)) {
        vs.leftKeys.add(p.key);
        renderOppList();
      }
    }
    const remaining = vs.roster.filter(p => !vs.leftKeys.has(p.key));
    if (remaining.length < 2) { endMatchAbrupt('Everyone else left the game'); return; }
    maybeSettle();
    maybeGoHost();
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
  const roster = playersInRoom();
  send('start_match', { ids, roster });
  await onStartMatch({ ids, roster });
}

async function onStartMatch({ ids, roster }) {
  const all = await loadPuzzles();
  vs.puzzles = ids.map(id => all.find(e => e.id === id)).filter(Boolean);
  vs.roster = roster;
  vs.leftKeys = new Set();
  vs.roundIdx = 0;
  vs.tally = Object.fromEntries(roster.map(p => [p.key, { wins: 0, found: 0, elapsed: 0 }]));
  vs.active = true;
  vs.matchOver = false;
  document.body.classList.add('versus');
  beginRound();
}

function activeOpponents() {
  return vs.roster.filter(p => p.key !== vs.myId && !vs.leftKeys.has(p.key));
}

async function beginRound() {
  const puzzle = vs.puzzles[vs.roundIdx];
  vs.results = {}; vs.readySet = new Set([vs.myId]);
  vs.inRound = true; vs.personalDone = false; vs.hurryFired = false; vs._counting = false;
  vs.roster.forEach(p => { p.progress = 0; p.status = ''; });
  document.body.classList.remove('player-done', 'review');

  show('game');
  $('#game-level').textContent = `Round ${vs.roundIdx + 1}/${ROUNDS}`;
  $('#found-count').textContent = `0/${puzzle.count}`;
  renderDots(0, puzzle.count);
  renderOppList();
  renderScoreline();
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
      send('progress', { round: vs.roundIdx, found });
    },
    onWin: () => myRoundDone({ complete: true, found: puzzle.count, elapsed: +vs.round.elapsed.toFixed(2) }),
    onLose: () => {
      // personal timeout: grey out, reveal answers, keep watching others
      myRoundDone({ complete: false, found: vs.round.found.size, elapsed: +vs.round.elapsed.toFixed(2) });
    },
  }, { pauseOnHide: false });
  vs.round.resetZoom();

  // ready handshake (re-sent — broadcasts can be missed during round transitions)
  const sendReady = () => send('ready', { round: vs.roundIdx });
  sendReady();
  clearInterval(vs.readyTimer);
  vs.readyTimer = setInterval(() => {
    if (!vs.inRound || vs.round?.running) { clearInterval(vs.readyTimer); return; }
    sendReady();
  }, 1200);
  maybeGoHost();
}

function onOppReady({ round, from }) {
  if (round !== vs.roundIdx) return;
  vs.readySet.add(from);
  maybeGoHost();
}

function maybeGoHost() {
  if (!vs.isHost || !vs.inRound || vs.round?.running || vs._counting) return;
  const needed = vs.roster.filter(p => !vs.leftKeys.has(p.key)).map(p => p.key);
  if (needed.every(k => vs.readySet.has(k))) {
    send('go', { round: vs.roundIdx });
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

/* ---------- during round ---------- */
function onOppProgress({ round, from, found }) {
  if (round !== vs.roundIdx) return;
  const opp = vs.roster.find(p => p.key === from);
  if (!opp) return;
  opp.progress = found;
  renderOppList();
  // hurry-up alarm: someone is one away from finishing
  const total = vs.puzzles[vs.roundIdx].count;
  if (!vs.hurryFired && !vs.personalDone && found >= total - 1 && total >= 3 && vs.round?.running) {
    vs.hurryFired = true;
    hurryUp(opp.name);
  }
}

function hurryUp(name) {
  sfx.siren(); vibrate([80, 60, 80, 60, 80]);
  const el = document.createElement('div');
  el.className = 'hurry';
  el.innerHTML = `<div class="hurry-label">🚨 ${esc(name)} is about to finish — HURRY!</div>`;
  $('#screen-game').appendChild(el);
  setTimeout(() => el.remove(), 2600);
}

function myRoundDone(result) {
  if (vs.results[vs.myId]) return;
  vs.results[vs.myId] = result;
  vs.personalDone = true;

  if (!result.complete) {
    // feature 1: grey out my board and show where the answers were
    document.body.classList.add('player-done');
    vs.round?.revealAnswers();
    showDoneBanner("⏱ Time's up — answers revealed. Waiting for others…");
  }

  const doSend = () => send('round_done', { round: vs.roundIdx, ...result });
  doSend();
  clearInterval(vs.resultTimer);
  vs.resultTimer = setInterval(() => {
    if (!vs.active || !vs.inRound) { clearInterval(vs.resultTimer); return; }
    doSend();
  }, 1500);

  // hard deadline: when the round's max time is up, settle immediately even if
  // someone's result never arrived (phone locked, connection died, walked away)
  const remaining = Math.max(0, vs.round?.timeLeft ?? 0);
  clearTimeout(vs.settleTimer);
  vs.settleTimer = setTimeout(forceSettle, (remaining + 3) * 1000);

  maybeSettle();
}

function forceSettle() {
  if (!vs.inRound || !vs.results[vs.myId]) return;
  for (const p of vs.roster) {
    if (vs.leftKeys.has(p.key) || vs.results[p.key]) continue;
    vs.results[p.key] = { complete: false, found: p.progress || 0, elapsed: vs.round?.totalTime ?? 999 };
  }
  maybeSettle();
}

function onOppRoundDone(payload) {
  if (payload.round !== vs.roundIdx) return;
  const opp = vs.roster.find(p => p.key === payload.from);
  if (!opp) return;
  vs.results[payload.from] = payload;
  opp.progress = payload.found;
  opp.status = payload.complete ? 'done' : 'timeout';
  renderOppList();

  // race rule: the first player to complete everything ends the round for everyone
  if (payload.complete && !vs.results[vs.myId] && vs.round && !vs.round.finished) {
    vs.round.halt();
    myRoundDone({ complete: false, found: vs.round.found.size, elapsed: +vs.round.elapsed.toFixed(2) });
    showDoneBanner(`🏁 ${esc(opp.name)} found them all!`);
    return;
  }
  maybeSettle();
}

/* ---------- settlement ---------- */
function maybeSettle() {
  if (!vs.inRound) return;
  const needed = vs.roster.filter(p => !vs.leftKeys.has(p.key));
  if (!needed.every(p => vs.results[p.key])) return;
  vs.inRound = false;
  clearTimers();
  settle(needed);
}

async function settle(participants) {
  const total = vs.puzzles[vs.roundIdx].count;
  const ranking = participants.map(p => ({ ...p, ...vs.results[p.key] }))
    .sort((a, b) =>
      (b.complete - a.complete) ||
      (a.complete ? a.elapsed - b.elapsed : b.found - a.found) ||
      (a.elapsed - b.elapsed));

  // shared ranks for exact ties
  ranking.forEach((r, i) => {
    r.rank = (i > 0 && tieWith(r, ranking[i - 1])) ? ranking[i - 1].rank : i + 1;
  });
  for (const r of ranking) {
    vs.tally[r.key].found += r.found;
    vs.tally[r.key].elapsed += r.elapsed;
    if (r.rank === 1) vs.tally[r.key].wins++;
  }
  renderScoreline();

  // feature 3: answer review window before the scoreboard
  document.body.classList.add('review');
  vs.round?.revealAnswers();
  showDoneBanner('🔍 Answer check…');
  await sleep(3000);
  hideDoneBanner();
  document.body.classList.remove('review', 'player-done');

  const myRank = ranking.find(r => r.key === vs.myId)?.rank || ranking.length;
  showRoundResult(ranking, myRank, total);
}

function tieWith(a, b) {
  return a.complete === b.complete && a.found === b.found && Math.abs(a.elapsed - b.elapsed) < 0.05;
}

async function showRoundResult(ranking, myRank, total) {
  const last = vs.roundIdx >= ROUNDS - 1;
  if (myRank === 1) { sfx.win(); vibrate([40, 60, 80]); } else sfx.lose();

  $('#result-fail').style.display = 'none';
  $$('#result-stars span').forEach(s => s.classList.remove('on', 'pop'));
  $('#result-title').textContent = myRank === 1 ? 'Round won! 🎉' : `${ordinal(myRank)} place`;
  $('#result-sub').textContent = `Round ${vs.roundIdx + 1} of ${ROUNDS}`;
  $('#result-list').innerHTML = ranking.map(r => `
    <div class="rank-row${r.key === vs.myId ? ' me' : ''}">
      <span class="rk">${r.rank}</span>
      <span class="nm">${esc(r.name)}${r.key === vs.myId ? ' (you)' : ''}</span>
      <span class="sc">${r.found}/${total}${r.complete ? ` · ${r.elapsed.toFixed(1)}s` : ''}</span>
    </div>`).join('');
  $('#result-list').style.display = '';
  $('#btn-next').style.display = 'none';
  $('#btn-result-home').style.display = 'none';
  $('#result').classList.add('on');

  await sleep(3600);
  $('#result').classList.remove('on');
  $('#result-list').style.display = 'none';
  $('#btn-next').style.display = '';
  $('#btn-result-home').style.display = '';
  if (!vs.active) return;

  if (!last) {
    vs.roundIdx++;
    beginRound();
  } else {
    showMatchResult();
  }
}

function showMatchResult() {
  const participants = vs.roster.filter(p => !vs.leftKeys.has(p.key));
  const board = participants.map(p => ({ ...p, ...vs.tally[p.key] }))
    .sort((a, b) => (b.wins - a.wins) || (b.found - a.found) || (a.elapsed - b.elapsed));
  board.forEach((r, i) => {
    r.rank = (i > 0 && r.wins === board[i - 1].wins && r.found === board[i - 1].found) ? board[i - 1].rank : i + 1;
  });
  const me = board.find(r => r.key === vs.myId);
  const won = me?.rank === 1;
  if (won) { confetti(); sfx.win(); }

  const medals = ['🥇', '🥈', '🥉'];
  $('#result-fail').style.display = 'none';
  $$('#result-stars span').forEach((s, i) => {
    s.classList.remove('on', 'pop');
    if (won) setTimeout(() => s.classList.add('on', 'pop'), 250 + i * 220);
  });
  $('#result-title').textContent = won ? 'You win the match! 🏆' : `${esc(board[0].name)} wins!`;
  $('#result-sub').textContent = 'Final standings';
  $('#result-list').innerHTML = board.map(r => `
    <div class="rank-row${r.key === vs.myId ? ' me' : ''}">
      <span class="rk">${medals[r.rank - 1] || r.rank}</span>
      <span class="nm">${esc(r.name)}${r.key === vs.myId ? ' (you)' : ''}</span>
      <span class="sc">${r.wins} win${r.wins === 1 ? '' : 's'} · ${r.found} found</span>
    </div>`).join('');
  $('#result-list').style.display = '';
  $('#btn-next').textContent = vs.isHost ? 'Rematch ↻' : 'Waiting for host…';
  $('#btn-next').disabled = !vs.isHost;
  $('#result').classList.add('on');
  vs.matchOver = true;
}

export async function nextAction() {
  if (vs.matchOver && vs.isHost) {
    vs.matchOver = false;
    $('#result').classList.remove('on');
    $('#result-list').style.display = 'none';
    $('#btn-next').disabled = false;
    await hostStart();
  }
}

/* ---------- exits ---------- */
function endMatchAbrupt(msg) {
  clearTimers();
  vs.round?.destroy(); vs.round = null;
  vs.active = false; vs.inRound = false;
  document.body.classList.remove('versus', 'player-done', 'review');
  hideDoneBanner();
  $('#result').classList.remove('on');
  alert(msg);
  leave();
}

export async function leave() {
  clearTimers();
  vs.round?.destroy(); vs.round = null;
  vs.active = false; vs.inRound = false; vs.matchOver = false;
  document.body.classList.remove('versus', 'player-done', 'review');
  hideDoneBanner();
  $('#result').classList.remove('on');
  $('#result-list').style.display = 'none';
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

function renderOppList() {
  const total = vs.puzzles[vs.roundIdx]?.count || 0;
  $('#opp-list').innerHTML = activeOpponents().map(p => {
    const icon = p.status === 'done' ? '✓' : p.status === 'timeout' ? '⏱' : '';
    return `<span class="opp-pill${p.status === 'done' ? ' finished' : ''}">
      ${esc(p.name)} <b>${p.progress || 0}/${total}</b>${icon ? ` ${icon}` : ''}</span>`;
  }).join('');
}

function renderScoreline() {
  const opp = activeOpponents();
  if (vs.roster.length === 2 && opp.length === 1) {
    $('#vs-scoreline').textContent = `${vs.tally[vs.myId]?.wins ?? 0} : ${vs.tally[opp[0].key]?.wins ?? 0}`;
  } else {
    $('#vs-scoreline').textContent = `★ ${vs.tally[vs.myId]?.wins ?? 0}`;
  }
}

function showDoneBanner(text) {
  let b = $('#done-banner');
  if (!b) {
    b = document.createElement('div');
    b.id = 'done-banner';
    $('#screen-game').appendChild(b);
  }
  b.textContent = text;
  b.classList.add('on');
}
function hideDoneBanner() { $('#done-banner')?.classList.remove('on'); }

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

  // chat
  $('#btn-chat').addEventListener('click', () => { sfx.click(); setChatOpen(!vs.chatOpen); });
  $('#chat-close').addEventListener('click', () => setChatOpen(false));
  for (const [inputId, btnId] of [['chat-input-lobby', 'chat-send-lobby'], ['chat-input-game', 'chat-send-game']]) {
    const input = document.getElementById(inputId);
    document.getElementById(btnId).addEventListener('click', () => sendChat(input));
    input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); sendChat(input); } });
  }
}
