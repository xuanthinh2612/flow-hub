// Shared helpers for the Flow Hub dashboard (no framework, no build step).

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** replaceChildren that skips null / false (the native one prints them as text). */
export function fill(el, ...children) {
  el.replaceChildren(...children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false));
  return el;
}

export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v;
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : String(c));
  }
  return el;
}

// ── preferences (per-browser conveniences only) ──
export function loadPref(key, fallback) {
  try {
    const raw = localStorage.getItem(`flowhub.${key}`);
    if (raw === null) return fallback;
    const parsed = JSON.parse(raw);
    const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
    return isObj(fallback) && isObj(parsed) ? { ...fallback, ...parsed } : parsed;
  } catch {
    return fallback;
  }
}
export function savePref(key, value) {
  try { localStorage.setItem(`flowhub.${key}`, JSON.stringify(value)); } catch { /* private mode */ }
}

// ── API ──
let apiKey = '';
try { apiKey = localStorage.getItem('flowhub.apiKey') || ''; } catch { /* ignore */ }

export async function api(path, { method = 'GET', body, form } = {}) {
  const headers = {};
  if (apiKey) headers['X-API-Key'] = apiKey;
  let payload;
  if (form) payload = form;
  else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const resp = await fetch(path, { method, headers, body: payload });
  if (resp.status === 401) {
    askKey();
    throw new Error('Cần API key');
  }
  const isJson = (resp.headers.get('content-type') || '').includes('json');
  const data = isJson ? await resp.json() : await resp.text();
  if (!resp.ok) {
    const detail = data && data.detail;
    throw new Error(typeof detail === 'string' ? detail : (detail ? JSON.stringify(detail) : `HTTP ${resp.status}`));
  }
  return data;
}

export function withKey(url) {
  return apiKey ? `${url}${url.includes('?') ? '&' : '?'}key=${encodeURIComponent(apiKey)}` : url;
}
export const mediaFile = (id) => withKey(`/api/media/${encodeURIComponent(id)}/file`);

let asking = false;
function askKey() {
  if (asking) return;
  asking = true;
  const input = h('input', { class: 'input mono', placeholder: 'API key', type: 'password' });
  openModal('Nhập API key', h('p', { class: 'hint' },
    'Server đang bật xác thực. Key được in ra khi khởi động server (hoặc đặt FLOWHUB_API_KEY trong .env).'),
  h('div', { class: 'inline' }, input, h('button', { class: 'btn btn-primary', onclick: () => {
    try { localStorage.setItem('flowhub.apiKey', input.value.trim()); } catch { /* ignore */ }
    location.reload();
  } }, 'Lưu')));
}

// ── events (SSE) ──
export function connectEvents(onEvent) {
  let source;
  const open = () => {
    source = new EventSource(withKey('/api/events'));
    source.onmessage = (e) => {
      try { onEvent(JSON.parse(e.data)); } catch { /* ignore */ }
    };
    source.onerror = () => { /* EventSource retries by itself */ };
  };
  open();
  return () => source && source.close();
}

// ── UI bits ──
export function toast(message, kind = '') {
  const el = h('div', { class: `toast ${kind}` }, message);
  $('#toasts').append(el);
  setTimeout(() => el.remove(), kind === 'err' ? 8000 : 3500);
}

export function openModal(title, ...children) {
  $('#modal-title').textContent = title;
  fill($('#modal-body'), ...children.flat());
  const modal = $('#modal');
  if (!modal.open) modal.showModal();
}
export function closeModal() {
  const modal = $('#modal');
  if (modal.open) modal.close();
}

export async function copy(text, label = 'Đã copy') {
  try {
    await navigator.clipboard.writeText(text);
    toast(label, 'ok');
  } catch (e) {
    toast(`Không copy được: ${e.message}`, 'err');
  }
}

export function ago(ts) {
  if (!ts) return '';
  const s = Math.max(0, Math.round(Date.now() / 1000 - ts));
  if (s < 10) return 'vừa xong';
  if (s < 60) return `${s} giây trước`;
  if (s < 3600) return `${Math.floor(s / 60)} phút trước`;
  if (s < 86400) return `${Math.floor(s / 3600)} giờ trước`;
  return new Date(ts * 1000).toLocaleString('vi-VN');
}

export function clock(ts) {
  const d = new Date(ts * 1000);
  const time = d.toLocaleTimeString('vi-VN', { hour12: false }) + '.' + String(d.getMilliseconds()).padStart(3, '0');
  return d.toDateString() === new Date().toDateString() ? time : `${d.toLocaleDateString('vi-VN')} ${time}`;
}

export const STATUS_LABEL = {
  queued: 'chờ', running: 'đang gửi', polling: 'đang render', done: 'xong', partial: 'xong một phần',
  failed: 'lỗi', timeout: 'hết giờ', canceled: 'đã huỷ',
};
export const statusPill = (status) => h('span', { class: `status ${status}` }, STATUS_LABEL[status] || status);

/** Display-only: long strings with no spaces (captcha tokens) are shortened. */
function displayJson(v) {
  if (typeof v === 'string' && v.length > 160 && !/\s/.test(v)) {
    return `${JSON.stringify(v.slice(0, 40)).slice(0, -1)}…(${v.length} ký tự)"`;
  }
  return JSON.stringify(v);
}

/** Readable JSON for Flow's positional arrays (copy buttons always use the raw value). */
export function fmt(value, indent = '') {
  if (!Array.isArray(value)) {
    if (value && typeof value === 'object') return JSON.stringify(value, null, 2).replace(/\n/g, `\n${indent}`);
    return displayJson(value);
  }
  const inner = indent + '  ';
  const parts = value.map((v) => (Array.isArray(v) ? fmt(v, inner) : displayJson(v)));
  const flat = `[${parts.join(',')}]`;
  if (!flat.includes('\n') && (flat.length <= 110 || !value.some(Array.isArray))) return flat;
  const lines = [];
  let run = [];
  const flush = () => { if (run.length) lines.push(inner + run.join(',')); run = []; };
  value.forEach((v, i) => {
    if (Array.isArray(v)) { flush(); lines.push(inner + parts[i]); } else run.push(parts[i]);
  });
  flush();
  return `[\n${lines.join(',\n')}\n${indent}]`;
}

/** Inner payload of an f.req string, or null. */
export function innerOf(freq) {
  try { return JSON.parse(JSON.parse(freq)[0][0][1]); } catch { return null; }
}

export function chipGroup(options, value, onChange, { toggle = false, cls = 'chips' } = {}) {
  const wrap = h('div', { class: cls });
  const render = (current) => {
    fill(wrap, ...options.map((o) => h('button', {
      type: 'button', class: `chip${String(o.value) === String(current) ? ' active' : ''}${o.isNew ? ' new' : ''}`,
      title: o.title || '',
      onclick: () => {
        const next = toggle && String(o.value) === String(current) ? null : o.value;
        render(next);
        onChange(next);
      },
    }, o.label, o.hint ? h('small', null, o.hint) : null)));
  };
  render(value);
  wrap.set = render;
  return wrap;
}

export function field(label, ...children) {
  return h('div', { class: 'field' }, label ? h('div', { class: 'field-label' }, label) : null, ...children);
}

// ── media ──
let mediaCache = null;
export function invalidateMedia() { mediaCache = null; }
export async function allMedia() {
  if (!mediaCache) mediaCache = api('/api/media?limit=1000').catch(() => []);
  return mediaCache;
}

export function mediaVisual(m, cls = '') {
  if (!m) return h('div', { class: 'noimg' }, '?');
  if (m.kind === 'video') {
    if (m.poster_url) return h('img', { src: withKey(`/api/media/${encodeURIComponent(m.id)}/poster`), loading: 'lazy', alt: '', class: cls });
    return h('video', { src: mediaFile(m.id), muted: true, preload: 'metadata', class: cls });
  }
  if (m.local_path || m.url) return h('img', { src: mediaFile(m.id), loading: 'lazy', alt: '', class: cls });
  return h('div', { class: 'noimg' }, m.id);
}

/** A field showing picked media ids as thumbnails, with a library picker. */
export function mediaPicker({ value, multi = false, onChange, kind = 'image' }) {
  const wrap = h('div', { class: 'picker' });
  let ids = Array.isArray(value) ? [...value] : (value ? [value] : []);
  const emit = () => onChange(multi ? [...ids] : (ids[0] || null));
  const render = async () => {
    const media = await allMedia();
    const byId = Object.fromEntries(media.map((m) => [m.id, m]));
    fill(wrap, 
      ...ids.map((id) => h('div', { class: 'pick', title: id },
        byId[id] ? mediaVisual(byId[id]) : h('div', { class: 'noimg' }, id.slice(0, 22)),
        h('button', { type: 'button', class: 'x', onclick: () => { ids = ids.filter((x) => x !== id); emit(); render(); } }, '✕'))),
      h('button', { type: 'button', class: 'pick-add', onclick: () => open() }, ids.length && !multi ? 'Đổi' : '+ Chọn'),
    );
  };
  const open = async () => {
    const media = (await allMedia()).filter((m) => m.kind === kind);
    let selected = [...ids];
    const paste = h('input', { class: 'input mono', placeholder: '…hoặc dán media ID', spellcheck: 'false' });
    const grid = h('div', { class: 'tiles' });
    const count = h('span', { class: 'muted' });
    const paint = () => {
      fill(grid, ...media.map((m) => h('div', {
        class: `tile${selected.includes(m.id) ? ' selected' : ''}`, title: m.prompt || m.id,
        onclick: () => {
          if (multi) selected = selected.includes(m.id) ? selected.filter((x) => x !== m.id) : [...selected, m.id];
          else selected = selected[0] === m.id ? [] : [m.id];
          paint();
        },
      }, mediaVisual(m), h('div', { class: 'meta' }, h('span', null, m.source || ''), h('span', null, ago(m.created_at))))));
      if (!media.length) fill(grid, h('p', { class: 'empty' }, 'Thư viện chưa có ảnh — tạo hoặc tải ảnh lên trước.'));
      count.textContent = `${selected.length} đã chọn`;
    };
    paint();
    openModal(multi ? 'Chọn ảnh (nhiều)' : 'Chọn 1 ảnh',
      h('div', { class: 'inline' }, paste, h('button', { class: 'btn btn-sm', onclick: () => {
        const id = paste.value.trim();
        if (!id) return;
        selected = multi ? [...new Set([...selected, id])] : [id];
        paste.value = '';
        paint();
      } }, 'Thêm ID')),
      grid,
      h('div', { class: 'actions' }, count, h('button', { class: 'btn btn-primary', onclick: () => {
        ids = selected;
        emit();
        render();
        closeModal();
      } }, 'Xong')));
  };
  render();
  wrap.refresh = render;
  return wrap;
}

export function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}
