// Game-portal adapter — CrazyGames (SDK v3) and GameDistribution.
// The public web build never sets window.SH_PORTAL, so everything here no-ops;
// portal ZIPs (tools/build-portal.mjs) stamp the global into index.html.
// A ?portal=crazygames|gd query works too, for local testing.
import { setDucked } from './audio.js';

const qs = new URLSearchParams(location.search);
export const PORTAL = window.SH_PORTAL || qs.get('portal') || '';
export const inPortal = !!PORTAL;

const GD_GAME_ID = window.SH_GD_GAME_ID || ''; // stamped by the GD build

const AD_MIN_GAP = 180000; // portals expect ≥ ~3 min between midgame ads
let cg = null;             // CrazyGames SDK handle once init'd and usable
let showing = false;       // an ad is on screen right now
let lastAdAt = Date.now(); // first midgame no sooner than one gap after boot
let breaks = 0;            // natural breaks seen since the last ad

// the game supplies pause/resume hooks so ads freeze the round timer
let hooks = { pause: () => {}, resume: () => {} };
export function onAdBreak(pause, resume) { hooks = { pause, resume }; }

function adStart() { if (!showing) { showing = true; setDucked(true); hooks.pause(); } }
function adEnd() { if (showing) { showing = false; setDucked(false); hooks.resume(); } }

function loadScript(src) {
  return new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = src; s.onload = res; s.onerror = rej;
    document.head.appendChild(s);
  });
}

/* ---------- init ---------- */
export async function portalInit() {
  if (PORTAL === 'crazygames') {
    try {
      if (!window.CrazyGames?.SDK) await loadScript('https://sdk.crazygames.com/crazygames-sdk-v3.js');
      const sdk = window.CrazyGames?.SDK;
      await sdk.init();
      if (sdk.environment !== 'disabled') cg = sdk;
    } catch { cg = null; }
  } else if (PORTAL === 'gd') {
    window.GD_OPTIONS = {
      gameId: GD_GAME_ID,
      onEvent: (ev) => {
        if (ev.name === 'SDK_GAME_PAUSE') adStart();
        else if (ev.name === 'SDK_GAME_START') adEnd();
      },
    };
    if (!window.gdsdk) loadScript('https://html5.api.gamedistribution.com/main.min.js').catch(() => {});
  }
}

/* ---------- gameplay telemetry (CrazyGames cares; GD ignores) ---------- */
export function loadingStart() { try { cg?.game.loadingStart(); } catch {} }
export function loadingStop() { try { cg?.game.loadingStop(); } catch {} }
export function gameplayStart() { try { cg?.game.gameplayStart(); } catch {} }
export function gameplayStop() { try { cg?.game.gameplayStop(); } catch {} }
export function happytime() { try { cg?.game.happytime(); } catch {} }

/* ---------- ads ---------- */
function cgAd(type) {
  return new Promise((res) => {
    let settled = false;
    const done = (ok) => { if (!settled) { settled = true; adEnd(); res(ok); } };
    try {
      cg.ad.requestAd(type, {
        adStarted: () => adStart(),
        adFinished: () => done(true),
        adError: () => done(false),
      });
    } catch { done(false); }
  });
}

async function gdMidgame() {
  try { adStart(); await window.gdsdk?.showAd?.(); } catch {} finally { adEnd(); }
}

// call at every natural break (solo "next puzzle"); runs cb exactly once,
// after an ad if one is due — every 3rd break and at most every 3 minutes
export async function maybeMidgame(cb) {
  breaks++;
  const due = breaks >= 3 && Date.now() - lastAdAt >= AD_MIN_GAP && !showing;
  if (!inPortal || !due || (PORTAL === 'crazygames' && !cg)) { cb(); return; }
  breaks = 0;
  if (PORTAL === 'crazygames') await cgAd('midgame');
  else if (PORTAL === 'gd') await gdMidgame();
  lastAdAt = Date.now();
  cb();
}

// E2E hook: lets tests wind the ad-gate clock without waiting 3 real minutes
export const __test = {
  set lastAdAt(v) { lastAdAt = v; },
  set breaks(v) { breaks = v; },
  get breaks() { return breaks; },
  get showing() { return showing; },
};

export function rewardedOn() {
  return PORTAL === 'crazygames' ? !!cg : PORTAL === 'gd' ? !!window.gdsdk : false;
}

// resolves true only when the ad was actually watched (grant the reward)
export async function rewardedAd() {
  if (!rewardedOn() || showing) return false;
  if (PORTAL === 'crazygames') {
    const ok = await cgAd('rewarded');
    if (ok) lastAdAt = Date.now();
    return ok;
  }
  try {
    await window.gdsdk.preloadAd('rewarded');
    adStart();
    await window.gdsdk.showAd('rewarded');
    lastAdAt = Date.now();
    return true;
  } catch { return false; } finally { adEnd(); }
}
