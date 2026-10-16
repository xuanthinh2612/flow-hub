/**
 * Flow Hub Worker — background service worker.
 *
 * A thin executor for a Flow Hub server. It dials the server's WebSocket and:
 *   - runs the batchexecute RPCs it is sent inside a signed-in flow.google.com
 *     tab (the cookie, the page's `at` token and a freshly minted single-use
 *     reCAPTCHA only exist there), and returns the raw response;
 *   - reports, passively, every batchexecute call and reCAPTCHA mint the Flow
 *     page makes (webRequest; responses through chrome.debugger when the
 *     server turns that on) — the Observation log on the server.
 * It never decides anything: request bodies, polling and storage are the
 * server's job, so a Flow update is fixed on the server, not here.
 *
 * The one body it builds itself is the credit balance read (nzlxg): a read-only
 * call the page makes on its own anyway, wanted for the popup and the icon's
 * tooltip, not asked for by the server.
 */

const VERSION = chrome.runtime.getManifest().version;
const FLOW_URL = 'https://flow.google.com/';
const FLOW_TABS = ['https://flow.google.com/*'];
const BATCH_PATH = '/_/AiSandboxAngularFrontend/data/batchexecute';
const CAPTCHA_SLOT = '__CAPTCHA__';
// Balance read: no parameters, answer `[credit, 1, 2, 2, null, credit, [ts, …]]`
// — slot 0 is the credits left, slot 5 repeats it. Request and response captured
// from Flow's own page on 2026-10-15 on an account holding 186 credits.
const RPC_CREDITS = 'nzlxg';
const CREDITS_FREQ = '[[["nzlxg","[]",null,"generic"]]]';
// Same set as POLL_RPCS in flowhub/protocol/batch.py — these read state instead
// of spending credits, so the balance is not re-read after one of them.
const POLL_RPC_IDS = new Set(['jwpduf', 'Zzl0ze', 'as29s', 'ngNC2', 'nzlxg']);
// The tooltip has to keep moving while the popup is closed, and a generating RPC
// costs credits at submit time, not when its answer lands: poll on an alarm, and
// re-read once after every non-polling RPC.
const CREDITS_ALARM = 'credits';
const CREDITS_REFRESH_MINUTES = 0.5;   // Chrome clamps anything shorter to 30 s
const CREDITS_AFTER_RPC_MS = 1500;
const MAX_RPC_TEXT = 32000000;      // the project listing alone is past 17 MB
const MATCH_CONTEXT = 300;          // text kept ahead of a `match` hit: ids Flow stores before the marker
const OBS_BATCH_URLS = ['https://flow.google.com/*batchexecute*'];
const OBS_RECAPTCHA_URLS = ['https://www.google.com/recaptcha/*', 'https://www.recaptcha.net/recaptcha/*'];
const MAX_FREQ = 1500000;
const MAX_RECAPTCHA_BODY = 262144;
const MAX_RESPONSE = 300000;
const OUTBOX_MAX = 300;
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

const DEFAULT_CFG = { serverUrl: 'ws://127.0.0.1:8787/ws/worker', token: '', label: '' };

let cfg = { ...DEFAULT_CFG };
let workerId = null;
let ws = null;
let wsState = 'off';           // off | connecting | open | unconfigured | rejected
let lastError = null;
let reconnectDelay = 2000;
let reconnectTimer = null;
let observeCfg = { enabled: true, responses: false };
const outbox = [];
const stats = { rpcs: 0, rpcErrors: 0, observed: 0, connectedAt: null };
// Last balance read for the account signed in on this profile. Memory only: it
// is a reading, not state the extension owns, and a new session re-reads it.
const credits = { value: null, ok: false, error: null, at: null };
let creditsInFlight = null;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── startup ────────────────────────────────────────────────

const ready = (async () => {
  const data = await chrome.storage.local.get(['cfg', 'workerId']);
  cfg = { ...DEFAULT_CFG, ...(data.cfg || {}) };
  workerId = data.workerId || crypto.randomUUID();
  if (!data.workerId) await chrome.storage.local.set({ workerId });
  connect();
})();

chrome.runtime.onInstalled.addListener(() => ready.then(connect));
chrome.runtime.onStartup.addListener(() => ready.then(connect));
chrome.alarms.create('watchdog', { periodInMinutes: 1 });
chrome.alarms.create(CREDITS_ALARM, { periodInMinutes: CREDITS_REFRESH_MINUTES });
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === 'watchdog' && wsState !== 'open' && wsState !== 'connecting') ready.then(connect);
  // The tooltip is the only credit indicator on screen while the popup is
  // closed, so it refreshes on its own whether or not the server is talking.
  if (a.name === CREDITS_ALARM) refreshCredits();
});

// ─── connection to the server ───────────────────────────────

function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  clearTimeout(reconnectTimer);
  if (!cfg.token || !cfg.serverUrl) {
    wsState = 'unconfigured';
    return;
  }
  let url;
  try {
    url = new URL(cfg.serverUrl);
    url.searchParams.set('token', cfg.token);
  } catch {
    wsState = 'unconfigured';
    lastError = 'URL server không hợp lệ';
    return;
  }
  wsState = 'connecting';
  try {
    ws = new WebSocket(url.toString());
  } catch (e) {
    lastError = e.message;
    scheduleReconnect();
    return;
  }
  ws.onopen = async () => {
    wsState = 'open';
    lastError = null;
    reconnectDelay = 2000;
    stats.connectedAt = Date.now();
    ws.send(JSON.stringify({ type: 'hello', worker_id: workerId, label: cfg.label || 'Chrome',
      version: VERSION, flow: await flowStatus(), ua: navigator.userAgent }));
    while (outbox.length && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(outbox.shift()));
  };
  ws.onmessage = (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    handle(msg).catch((e) => console.warn('[FlowHub] handler error', e));
  };
  ws.onclose = (event) => {
    ws = null;
    if (event.code === 4401) {
      wsState = 'rejected';
      lastError = 'Server từ chối token — kiểm tra token trong Cài đặt của server';
      return;   // retrying a wrong token is pointless; the popup reconnects on save
    }
    wsState = 'off';
    scheduleReconnect();
  };
  ws.onerror = () => {
    lastError = `Không kết nối được ${cfg.serverUrl}`;
  };
}

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connect, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, 30000);
}

function send(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
    return true;
  }
  if (msg.type === 'observe' || msg.type === 'observe_response') {
    outbox.push(msg);
    if (outbox.length > OUTBOX_MAX) outbox.shift();
  }
  return false;
}

// Keepalive: WebSocket traffic keeps an MV3 worker alive (Chrome 116+), and the
// server likes a fresh view of the Flow tabs anyway.
async function pushStatus() {
  if (ws && ws.readyState === WebSocket.OPEN) {
    send({ type: 'status', flow: await flowStatus(), stats, credits: { ...credits } });
  }
}
setInterval(pushStatus, 20000);

// A Flow tab moving to another project or account (/u/N/) is reported at once, so
// the next job uses the project open now rather than the one of 20 s ago.
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.url?.startsWith(FLOW_URL)) pushStatus().catch(() => {});
});
chrome.tabs.onActivated.addListener(() => { pushStatus().catch(() => {}); });
chrome.tabs.onRemoved.addListener(() => { pushStatus().catch(() => {}); });

async function handle(msg) {
  switch (msg.type) {
    case 'welcome':
      break;
    case 'config':
      observeCfg = { ...observeCfg, ...(msg.observe || {}) };
      syncDebugger().catch(() => {});
      break;
    case 'rpc':
      await runRpcCommand(msg);
      break;
    case 'fetch':
      await runFetchCommand(msg);
      break;
    default:
      break;
  }
}

// ─── RPC execution inside the Flow page ─────────────────────

async function runRpcCommand(msg) {
  stats.rpcs++;
  let out;
  try {
    out = await runBatchRpc({ rpcid: msg.rpcid, freq: msg.freq, captchaAction: msg.captcha_action,
      match: msg.match, reqid: msg.reqid });
  } catch (e) {
    out = { error: e?.message || String(e) };
  }
  if (out.error) stats.rpcErrors++;
  send({ type: 'rpc_result', id: msg.id, ...out });
  // A generating RPC spends credits at submit time, so re-read shortly after —
  // but not after the polls, which change nothing and would only add traffic.
  if (!POLL_RPC_IDS.has(msg.rpcid)) setTimeout(refreshCredits, CREDITS_AFTER_RPC_MS);
}

async function runFetchCommand(msg) {
  try {
    const resp = await fetch(msg.url, { credentials: 'include' });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const buf = new Uint8Array(await resp.arrayBuffer());
    send({ type: 'fetch_result', id: msg.id, b64: bytesToB64(buf),
      mime: (resp.headers.get('content-type') || '').split(';')[0] });
  } catch (e) {
    send({ type: 'fetch_result', id: msg.id, error: e?.message || String(e) });
  }
}

function bytesToB64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

async function runBatchRpc(cmd) {
  const tabs = await chrome.tabs.query({ url: FLOW_TABS });
  // Prefer the tab showing the project the body names: with several Google
  // accounts signed in (flow.google.com/u/N/…) a project only exists in its own account.
  const showsProject = (t) => { const m = UUID_RE.exec(t.url || ''); return !!m && cmd.freq.includes(m[0]); };
  let candidate = tabs.find((t) => !t.discarded && showsProject(t)) || tabs.find(showsProject)
    || tabs.find((t) => !t.discarded) || tabs[0];
  if (!candidate) {
    try {
      const opened = await openFlowTab(false);
      await sleep(5000);
      candidate = opened?.id ? await chrome.tabs.get(opened.id).catch(() => null) : null;
    } catch (e) {
      return { error: e?.message || 'NO_FLOW_TAB' };
    }
    if (!candidate) return { error: 'NO_FLOW_TAB' };
  }
  const tab = await reviveTab(candidate);
  if (!tab) return { error: 'FLOW_TAB_DISCARDED' };

  let freq = cmd.freq;
  if (cmd.captchaAction && freq.includes(CAPTCHA_SLOT)) {
    const solved = await solveCaptcha(cmd.captchaAction, tab.id);
    if (!solved?.token) return { error: `CAPTCHA_FAILED: ${solved?.error || 'no token'}` };
    freq = freq.split(CAPTCHA_SLOT).join(solved.token);
  }
  const reqid = cmd.reqid || Math.floor(Math.random() * 900000) + 100000;
  const started = Date.now();

  const [injected] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    world: 'MAIN',
    args: [cmd.rpcid, freq, MAX_RPC_TEXT, cmd.match || null, BATCH_PATH, reqid, MATCH_CONTEXT],
    func: async (rpcid, freqStr, maxText, match, batchPath, reqid, matchContext) => {
      const wiz = globalThis.WIZ_global_data || {};
      const at = wiz.SNlM0e;
      if (!at) return { error: 'NO_AT_TOKEN (tab Flow chưa đăng nhập hoặc chưa tải xong)' };
      // Same WIZ metadata and header spelling as Flow's own client.
      const sourcePath = location.pathname || '/';
      // Signed into several Google accounts, Flow lives under /u/N/ and so do its
      // RPCs: the bare path is account 0's session, which rejects this tab's `at` (HTTP 400).
      const account = (sourcePath.match(/^\/u\/\d+(?=\/)/) || [''])[0];
      const hl = (document.documentElement.lang || navigator.language || 'en').split('-')[0];
      const url = `${account}${batchPath}?rpcids=${encodeURIComponent(rpcid)}` +
        `&source-path=${encodeURIComponent(sourcePath)}` +
        `&bl=${encodeURIComponent(wiz.cfb2h || '')}&f.sid=${encodeURIComponent(wiz.FdrFJe || '')}` +
        `&hl=${encodeURIComponent(hl)}&_reqid=${reqid}&rt=c`;
      let resp;
      let text;
      try {
        resp = await fetch(url, {
          method: 'POST',
          credentials: 'include',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
            'X-Same-Domain': '1',
          },
          body: new URLSearchParams({ 'f.req': freqStr, at }),
        });
        text = await resp.text();
      } catch (e) {
        return { error: `FETCH_FAILED: ${e?.message || e}` };
      }
      if (match) {
        // A marker or a list of them; every hit (up to 8 each) gets its own window.
        const windows = [];
        for (const marker of [].concat(match)) {
          for (let found = text.indexOf(marker), n = 0; found !== -1 && n < 8; found = text.indexOf(marker, found + 1), n++) {
            windows.push(text.slice(Math.max(0, found - matchContext), found + 800));
          }
        }
        return { status: resp.status, matched: windows.length > 0, text: windows.join('\n') };
      }
      return { status: resp.status, text: text.slice(0, maxText) };
    },
  });
  // No result at all: the page went away under the call (reload, navigation),
  // taking the fetch with it. Whether the request had already left the tab
  // tells the server if Flow is rendering it anyway.
  const out = injected?.result
    || { error: 'PAGE_UNLOADED: tab Flow tải lại hoặc chuyển trang khi đang chờ response' };
  if (out.error) out.sent = (sentReqids.get(String(reqid)) || 0) >= started;
  return out;
}

// ─── Credits (nzlxg) ───────────────────────────────────────

// The same read-only call the page makes for its own credit counter, run so the
// popup and the icon's tooltip can show the balance. It goes through runBatchRpc
// (the cookie and the `at` token only exist in the Flow tab) but on purpose not
// through runRpcCommand: this is not a job the server asked for, so it must not
// land in the RPC counters.

/** End of the JSON value starting at `start`, or -1. Strings and escapes respected. */
function jsonEnd(text, start) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
    } else if (c === '"') {
      inString = true;
    } else if (c === '[' || c === '{') {
      depth++;
    } else if (c === ']' || c === '}') {
      if (--depth === 0) return i + 1;
    }
  }
  return -1;
}

/**
 * `)]}'` sentinel plus length-prefixed chunks → [{rpcid, data, error}].
 *
 * Chunks are located by scanning for JSON values rather than by their length
 * prefix: once escapes are involved the prefix can disagree with the payload by
 * a byte, which is exactly why protocol/batch.py parses it this way too. The
 * `["di",…]`/`["af.httprm",…]` bookkeeping and the trailing `["e",4,…]` chunk
 * carry no `wrb.fr` entry and are skipped.
 */
function decodeEnvelope(text) {
  const results = [];
  if (!text) return results;
  let body = text;
  if (body.startsWith(")]}'")) {
    const nl = body.indexOf('\n');
    if (nl === -1) return results;
    body = body.slice(nl + 1);
  }
  let index = 0;
  while (index < body.length) {
    const start = body.indexOf('[', index);
    if (start === -1) break;
    const end = jsonEnd(body, start);
    if (end === -1) break;
    let chunk;
    try {
      chunk = JSON.parse(body.slice(start, end));
    } catch {
      index = start + 1;
      continue;
    }
    index = end;
    if (!Array.isArray(chunk)) continue;
    for (const entry of chunk) {
      if (!Array.isArray(entry) || entry[0] !== 'wrb.fr') continue;
      const rpcid = entry[1] ?? '?';
      const payload = entry[2];
      if (payload === null || payload === undefined) {
        results.push({ rpcid, data: null, error: entry[5] ?? true });
        continue;
      }
      try {
        results.push({ rpcid, data: typeof payload === 'string' ? JSON.parse(payload) : payload, error: null });
      } catch {
        results.push({ rpcid, data: null, error: 'BAD_PAYLOAD_JSON' });
      }
    }
  }
  return results;
}

/** Error slot of an envelope → a short reason, the way describe_error does it. */
function describeRpcError(detail) {
  const text = JSON.stringify(detail ?? '');
  const reasons = [...new Set([...text.matchAll(/"([A-Z][A-Z_]{3,})"/g)].map((m) => m[1]))];
  const code = Array.isArray(detail) && typeof detail[0] === 'number' ? detail[0] : null;
  const reason = reasons.join(', ') || text.slice(0, 160);
  return code === null ? reason : `${reason} (code ${code})`;
}

/**
 * nzlxg → the credits left. Payload `[186,1,2,2,null,186,[…]]` as captured on
 * 2026-10-15: slot 0 is the balance and slot 5 repeats it, so slot 0 is read
 * and slot 5 is the fallback should Flow ever reorder the record.
 */
function readCredits(text) {
  const results = decodeEnvelope(text);
  const hit = results.find((r) => r.rpcid === RPC_CREDITS);
  if (!hit) throw new Error(`no ${RPC_CREDITS} envelope (${results.length} others)`);
  if (hit.error) throw new Error(describeRpcError(hit.error));
  const value = Array.isArray(hit.data)
    ? [hit.data[0], hit.data[5]].find((n) => typeof n === 'number')
    : null;
  if (value === undefined || value === null) {
    throw new Error(`unexpected ${RPC_CREDITS} payload: ${JSON.stringify(hit.data)?.slice(0, 160)}`);
  }
  return Math.round(value);
}

async function fetchCredits() {
  // Never open a tab for this: a profile with no Flow tab open has no account to
  // read, and runBatchRpc would otherwise spawn one every 30 seconds.
  if (!(await chrome.tabs.query({ url: FLOW_TABS })).length) return { error: 'NO_FLOW_TAB' };
  const out = await runBatchRpc({ rpcid: RPC_CREDITS, freq: CREDITS_FREQ });
  if (out?.error) return { error: out.error };
  if (out.status && out.status !== 200) return { error: `HTTP ${out.status}` };
  try {
    return { value: readCredits(out.text || '') };
  } catch (e) {
    return { error: e?.message || String(e) };
  }
}

/** One read at a time: the alarm, a finished RPC and the popup can all ask. */
function refreshCredits() {
  if (creditsInFlight) return creditsInFlight;
  creditsInFlight = fetchCredits()
    .then((result) => {
      // A failed read keeps the balance that was last known — still this
      // account's number, just not fresh — and marks it stale rather than
      // blanking it out.
      if (result.error) credits.error = result.error;
      else {
        credits.value = result.value;
        credits.error = null;
      }
      credits.ok = !result.error;
      credits.at = Date.now();
      paintCredits();
      return credits;
    })
    .catch((e) => {
      console.warn('[FlowHub] credit read', e?.message);
      return credits;
    })
    .finally(() => { creditsInFlight = null; });
  return creditsInFlight;
}

function paintCredits() {
  const known = credits.value !== null;
  // The toolbar icon must stay clear: Chrome shrinks the icon under a badge, so
  // a balance like `186` covers it whenever the popup is closed. The number
  // lives in this tooltip (hover the icon) and in the popup, both of which
  // always carry it exactly.
  const title = known
    ? `Flow Hub Worker — ${credits.value} credit${credits.ok ? '' : ` (cũ: ${credits.error})`}`
    : `Flow Hub Worker${credits.error ? ` — chưa đọc được credit (${credits.error})` : ''}`;
  try {
    // Explicitly clear — not just skip — so a badge painted by an older build
    // (or by Chrome's default) never lingers over the icon.
    chrome.action.setBadgeText({ text: '' });
    chrome.action.setTitle({ title });
  } catch (e) {
    console.warn('[FlowHub] credit tooltip', e?.message);
  }
}

// ─── Flow tabs ──────────────────────────────────────────────

async function openFlowTab(active = false) {
  try {
    return await chrome.tabs.create({ url: FLOW_URL, active });
  } catch (e) {
    if (!String(e?.message).includes('No current window')) throw e;
    const win = await chrome.windows.create({ url: FLOW_URL, focused: false, state: 'minimized' });
    return win.tabs?.[0] ?? null;
  }
}

async function reviveTab(tab) {
  if (!tab?.discarded) return tab;
  try {
    await chrome.tabs.reload(tab.id);
    await sleep(2500);
    return await chrome.tabs.get(tab.id);
  } catch {
    return null;
  }
}

async function flowStatus() {
  const tabs = await chrome.tabs.query({ url: FLOW_TABS });
  const projects = [];
  for (const t of tabs) {
    const m = UUID_RE.exec(t.url || '');
    if (m) {
      const existing = projects.find((p) => p.projectId === m[0]);
      if (!existing) {
        projects.push({ projectId: m[0], title: t.title || '', active: !!t.active });
      } else if (t.active) {
        existing.title = t.title || existing.title;
        existing.active = true;
      }
    }
  }
  projects.sort((a, b) => Number(b.active) - Number(a.active));
  return { tabs: tabs.length, live: tabs.filter((t) => !t.discarded).length, projects };
}

// ─── reCAPTCHA (bridge to injected.js through content.js) ──

const solvingTabs = new Map();   // tabId -> { count, action } while we mint there

async function requestCaptchaFromTab(tabId, pageAction) {
  const requestId = crypto.randomUUID();   // fresh per mint: replies are paired by it
  try {
    return await chrome.tabs.sendMessage(tabId, { type: 'GET_CAPTCHA', requestId, pageAction });
  } catch (error) {
    const msg = error?.message || '';
    if (!msg.includes('Receiving end does not exist') && !msg.includes('Could not establish connection')) throw error;
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    await sleep(200);
    return await chrome.tabs.sendMessage(tabId, { type: 'GET_CAPTCHA', requestId, pageAction });
  }
}

function captchaFromTab(tabId, action) {
  let timer;
  const timeout = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('CAPTCHA_TIMEOUT')), 30000); });
  const cur = solvingTabs.get(tabId) || { count: 0 };
  solvingTabs.set(tabId, { count: cur.count + 1, action });
  return Promise.race([requestCaptchaFromTab(tabId, action), timeout]).finally(() => {
    clearTimeout(timer);
    setTimeout(() => {
      const now = solvingTabs.get(tabId);
      if (!now) return;
      if (now.count <= 1) solvingTabs.delete(tabId);
      else solvingTabs.set(tabId, { ...now, count: now.count - 1 });
    }, 1500);
  });
}

async function solveCaptcha(action, preferTabId) {
  const tabs = await chrome.tabs.query({ url: FLOW_TABS });
  const candidates = [...tabs.filter((t) => t.id === preferTabId), ...tabs.filter((t) => t.id !== preferTabId)];
  const errors = [];
  for (const tab of candidates) {
    const live = await reviveTab(tab);
    if (!live) continue;
    try {
      const resp = await captchaFromTab(live.id, action);
      if (resp?.token) return resp;
      errors.push(resp?.error || 'NO_TOKEN');
    } catch (e) {
      errors.push(e?.message || String(e));
    }
  }
  return { error: errors[0] || 'NO_FLOW_TAB' };
}

// ─── Observation (passive) ──────────────────────────────────

const pendingObs = new Map();   // webRequest requestId -> partial entry
const sentReqids = new Map();   // _reqid -> when that batchexecute left a Flow tab (kept even with Observation off)
const SENT_MAX = 500;

function noteSent(url) {
  const reqid = new URL(url).searchParams.get('_reqid');
  if (!reqid) return;
  sentReqids.set(reqid, Date.now());
  if (sentReqids.size > SENT_MAX) sentReqids.delete(sentReqids.keys().next().value);
}

function readForm(body) {
  const form = new URLSearchParams();
  if (body?.formData) {
    for (const [k, values] of Object.entries(body.formData)) for (const v of values) form.append(k, v);
  } else if (body?.raw?.length) {
    const text = body.raw.map((p) => (p.bytes ? new TextDecoder().decode(p.bytes) : '')).join('');
    for (const [k, v] of new URLSearchParams(text)) form.append(k, v);
  }
  return form;
}

chrome.webRequest.onBeforeRequest.addListener((d) => {
  if (d.method !== 'POST') return;
  noteSent(d.url);
  if (!observeCfg.enabled) return;
  const form = readForm(d.requestBody);
  const raw = form.get('f.req') || '';
  // Upload bodies carry the whole image as base64: keep its length, not its bytes,
  // so the rest of the body still decodes on the server.
  const freq = raw.length > 20000 ? raw.replace(/[A-Za-z0-9+/=]{20000,}/g, (m) => `<base64 ${m.length}>`) : raw;
  pendingObs.set(d.requestId, {
    kind: 'batchexecute', url: d.url, ts: d.timeStamp, tab_id: d.tabId,
    freq: freq.length > MAX_FREQ ? freq.slice(0, MAX_FREQ) : freq, freq_size: raw.length,
    form_keys: [...new Set(form.keys())], start: d.timeStamp,   // the `at` value itself is never sent
  });
}, { urls: OBS_BATCH_URLS }, ['requestBody']);

chrome.webRequest.onBeforeRequest.addListener((d) => {
  if (!observeCfg.enabled || d.method !== 'POST' || d.tabId < 0) return;
  const parts = (d.requestBody?.raw || []).filter((p) => p.bytes).map((p) => new Uint8Array(p.bytes));
  const total = parts.reduce((n, p) => n + p.length, 0);
  const bytes = new Uint8Array(Math.min(total, MAX_RECAPTCHA_BODY));
  let offset = 0;
  for (const p of parts) {
    if (offset >= bytes.length) break;
    bytes.set(p.subarray(0, bytes.length - offset), offset);
    offset += p.length;
  }
  const ours = solvingTabs.get(d.tabId);
  pendingObs.set(d.requestId, {
    kind: 'recaptcha', url: d.url, ts: d.timeStamp, tab_id: d.tabId, start: d.timeStamp,
    body_b64: bytes.length ? bytesToB64(bytes) : null, ours: ours ? { action: ours.action } : null,
  });
}, { urls: OBS_RECAPTCHA_URLS }, ['requestBody']);

chrome.webRequest.onSendHeaders.addListener((d) => {
  const entry = pendingObs.get(d.requestId);
  if (!entry) return;
  entry.headers = (d.requestHeaders || []).map(({ name, value }) => {
    const lower = name.toLowerCase();
    if (lower === 'cookie') return { name, value: `‹${String(value || '').split(';').length} cookie›` };
    if (lower === 'authorization') return { name, value: '‹ẩn›' };
    return { name, value: value ?? '' };
  });
}, { urls: OBS_BATCH_URLS }, ['requestHeaders', 'extraHeaders']);

function finishObs(d, error) {
  const entry = pendingObs.get(d.requestId);
  if (!entry) return;
  pendingObs.delete(d.requestId);
  entry.status = d.statusCode ?? null;
  entry.duration_ms = Math.round(d.timeStamp - entry.start);
  entry.error = error || null;
  delete entry.start;
  stats.observed++;
  send({ type: 'observe', entry });
}

const FINISH_URLS = [...OBS_BATCH_URLS, ...OBS_RECAPTCHA_URLS];
chrome.webRequest.onCompleted.addListener((d) => finishObs(d, null), { urls: FINISH_URLS });
chrome.webRequest.onErrorOccurred.addListener((d) => finishObs(d, d.error), { urls: FINISH_URLS });

// ── responses via chrome.debugger (only when the server asks for them) ──

const debuggerTabs = new Set();
const cdpUrls = new Map();

async function attachDebugger(tabId) {
  if (debuggerTabs.has(tabId)) return;
  try {
    await chrome.debugger.attach({ tabId }, '1.3');
  } catch (e) {
    if (!/already attached/i.test(e?.message || '')) throw e;
  }
  debuggerTabs.add(tabId);
  await chrome.debugger.sendCommand({ tabId }, 'Network.enable', {});
}

async function syncDebugger() {
  if (!observeCfg.enabled || !observeCfg.responses) {
    for (const tabId of [...debuggerTabs]) {
      debuggerTabs.delete(tabId);
      try { await chrome.debugger.detach({ tabId }); } catch { /* gone */ }
    }
    return;
  }
  for (const tab of await chrome.tabs.query({ url: FLOW_TABS })) {
    try { await attachDebugger(tab.id); } catch (e) { console.warn('[FlowHub] debugger attach', e?.message); }
  }
}

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (observeCfg.enabled && observeCfg.responses && !debuggerTabs.has(tabId)
      && info.status === 'loading' && tab.url?.startsWith(FLOW_URL)) {
    attachDebugger(tabId).catch(() => {});
  }
});

chrome.debugger.onEvent.addListener(async (source, method, params) => {
  if (!debuggerTabs.has(source.tabId)) return;
  const key = `${source.tabId}:${params?.requestId}`;
  if (method === 'Network.requestWillBeSent') {
    if (params.request?.url?.includes('batchexecute')) cdpUrls.set(key, params.request.url);
    return;
  }
  if (method !== 'Network.loadingFinished' && method !== 'Network.loadingFailed') return;
  const url = cdpUrls.get(key);
  if (!url) return;
  cdpUrls.delete(key);
  if (method === 'Network.loadingFailed') return;
  try {
    const { body, base64Encoded } = await chrome.debugger.sendCommand(source, 'Network.getResponseBody',
      { requestId: params.requestId });
    let text = base64Encoded ? new TextDecoder().decode(Uint8Array.from(atob(body), (c) => c.charCodeAt(0))) : body;
    if (text.length > MAX_RESPONSE) text = text.slice(0, MAX_RESPONSE);
    send({ type: 'observe_response', url, text });
  } catch { /* the body is gone already */ }
});

chrome.debugger.onDetach.addListener((source, reason) => {
  debuggerTabs.delete(source.tabId);
  if (reason === 'canceled_by_user') {
    observeCfg.responses = false;
    send({ type: 'debugger_detached', reason });
  }
});

// ─── popup ──────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  (async () => {
    await ready;
    switch (msg?.type) {
      case 'STATUS':
        return { cfg: { ...cfg, token: cfg.token ? '••••' + cfg.token.slice(-4) : '' }, hasToken: !!cfg.token,
          workerId, state: wsState, lastError, stats, flow: await flowStatus(), observe: observeCfg,
          credits: { ...credits }, version: VERSION };
      case 'GET_CREDITS':
        // The popup asks on open, and on its refresh button, for a reading taken
        // now rather than the cached one.
        if (msg.force) await refreshCredits();
        return { credits: { ...credits } };
      case 'SAVE_CONFIG': {
        cfg = { ...cfg, serverUrl: msg.serverUrl?.trim() || cfg.serverUrl, label: msg.label ?? cfg.label };
        if (msg.token) cfg.token = msg.token.trim();
        await chrome.storage.local.set({ cfg });
        try { ws?.close(); } catch { /* ignore */ }
        ws = null;
        reconnectDelay = 2000;
        connect();
        return { ok: true };
      }
      case 'RECONNECT':
        try { ws?.close(); } catch { /* ignore */ }
        ws = null;
        connect();
        return { ok: true };
      case 'OPEN_FLOW': {
        const tabs = await chrome.tabs.query({ url: FLOW_TABS });
        if (tabs.length) {
          await chrome.tabs.update(tabs[0].id, { active: true });
          await chrome.windows.update(tabs[0].windowId, { focused: true }).catch(() => {});
        } else {
          await openFlowTab(true);
        }
        return { ok: true };
      }
      default:
        return { ok: false };
    }
  })().then(reply, (e) => reply({ ok: false, error: e?.message }));
  return true;
});

console.log('[FlowHub] worker loaded', VERSION);
