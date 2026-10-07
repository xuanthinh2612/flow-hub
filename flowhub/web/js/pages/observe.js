import { h, api, toast, clock, fmt, copy, debounce, withKey, loadPref, savePref, fill } from '../core.js';

let known = {};
const PREFS = 'observe';

function checkView(check) {
  if (!check) return null;
  const list = Array.isArray(check) ? check : [check];
  return list.map((c) => {
    if (!c.supported) return h('p', { class: 'muted' }, `Builder: ${c.reason || 'không hỗ trợ'}`);
    if (c.ok) return h('p', { class: 'ok' }, `✓ Builder của Flow Hub dựng ra body giống hệt trang${c.rpcid ? ` (${c.rpcid})` : ''}.`);
    return h('div', null, h('p', { class: 'err' }, `✕ Builder lệch với trang${c.rpcid ? ` (${c.rpcid})` : ''}${c.error ? `: ${c.error}` : ''}`),
      h('table', { class: 'list' }, h('tr', null, h('th', null, 'Vị trí'), h('th', null, 'Trang gửi'), h('th', null, 'Flow Hub dựng')),
        ...(c.diffs || []).map((d) => h('tr', null, h('td', { class: 'mono' }, d.path),
          h('td', { class: 'mono' }, JSON.stringify(d.observed)), h('td', { class: 'mono' }, JSON.stringify(d.built))))));
  });
}

function rebuildFreq(rpc) {
  return JSON.stringify([[[rpc.rpcid, rpc.inner !== undefined ? JSON.stringify(rpc.inner) : rpc.raw, null, rpc.tag || 'generic']]]);
}

async function detail(row, mount) {
  let e;
  try {
    e = await api(`/api/observations/${row.id}`);
  } catch (err) {
    fill(mount, h('p', { class: 'err' }, err.message));
    return;
  }
  const p = e.params || {};
  const kv = (k, v) => (v === null || v === undefined || v === '' ? [] : [h('dt', null, k), h('dd', null, String(v))]);
  if (e.kind === 'recaptcha') {
    fill(mount, h('dl', { class: 'kv' },
      kv('Endpoint', e.url), kv('Site key (k)', p.k), kv('Nguồn', e.source === 'hub' ? `Flow Hub mint (action yêu cầu ${e.requested_action})` : 'Trang Flow'),
      kv('Action', (e.actions || []).join(', ') || '— không thấy —'), kv('HTTP', e.status)),
    h('div', { class: 'section-title' }, `Chuỗi trong body protobuf (${(e.strings || []).length})`),
    h('div', { class: 'actions' }, h('button', { class: 'btn btn-sm', onclick: () => copy((e.strings || []).join('\n')) }, 'Copy')),
    h('pre', { class: 'body' }, (e.strings || []).join('\n')));
    return;
  }
  const headers = e.headers || [];
  const custom = headers.filter((x) => /^x-/i.test(x.name)).map((x) => x.name);
  const blocks = (e.rpcs || []).map((rpc, index) => h('div', null,
    h('div', { class: 'section-title' }, `${rpc.rpcid} — ${known[rpc.rpcid]?.name || 'RPC chưa biết'} `,
      h('span', { class: 'muted' }, `· inner ${rpc.size} ký tự${rpc.tag && rpc.tag !== 'generic' ? ` · tag "${rpc.tag}"` : ''}${rpc.shortened ? ' · chuỗi dài đã rút gọn khi lưu' : ''}`)),
    h('div', { class: 'actions' },
      rpc.inner !== undefined ? h('button', { class: 'btn btn-sm', onclick: () => copy(JSON.stringify(rpc.inner), 'Đã copy inner JSON') }, 'Copy inner JSON') : null,
      h('button', { class: 'btn btn-sm', onclick: () => copy(rebuildFreq(rpc), 'Đã copy f.req') }, 'Copy f.req'),
      rpc.inner !== undefined ? h('button', { class: 'btn btn-sm', onclick: async () => {
        try {
          const r = await api(`/api/observations/${e.id}/check?rpc_index=${index}`, { method: 'POST' });
          fill(checkMount, ...checkView(r));
        } catch (err) { toast(err.message, 'err'); }
      } }, 'Kiểm tra builder') : null,
      rpc.inner !== undefined ? h('button', { class: 'btn btn-sm', onclick: async () => {
        try {
          const t = await api(`/api/observations/${e.id}/template`, { method: 'POST', body: { rpc_index: index } });
          toast(`Đã tạo template #${t.id} (biến: ${t.variables.join(', ') || 'không'})`, 'ok');
          location.hash = `#/templates?id=${t.id}`;
        } catch (err) { toast(err.message, 'err'); }
      } }, 'Tạo template từ request này') : null),
    h('pre', { class: 'body' }, rpc.inner !== undefined ? fmt(rpc.inner) : String(rpc.raw ?? ''))));
  const checkMount = h('div', null, ...(checkView(e.check_result) || []));
  let response;
  if (!e.response) {
    response = h('p', { class: 'hint' }, 'Chưa có response — bật "Ghi cả response" trong Cài đặt (chỉ áp dụng cho request sau khi bật).');
  } else {
    response = h('div', null, ...(e.response.rpcs || []).map((r) => h('div', null,
      h('div', null, h('b', { class: 'mono' }, r.rpcid), r.error !== undefined ? h('span', { class: 'err' }, ` · lỗi ${r.error_text || JSON.stringify(r.error)}`) : ''),
      r.data !== undefined ? h('pre', { class: 'body' }, fmt(r.data)) : (r.data_size ? h('p', { class: 'hint' }, `Payload lớn (${r.data_size} ký tự) — xem raw.`) : null))),
    h('details', null, h('summary', { class: 'muted' }, `Raw response (${e.response.size} ký tự)`), h('pre', { class: 'body' }, e.response.raw || '')));
  }
  fill(mount, 
    h('dl', { class: 'kv' }, kv('URL', `https://flow.google.com${e.path}`), kv('rpcids', p.rpcids), kv('source-path', p['source-path']),
      kv('bl (build)', p.bl), kv('hl', p.hl), kv('_reqid', p._reqid), kv('form', `${(e.form_keys || []).join(', ')} (giá trị at không được gửi về server)`),
      kv('f.req', `${e.freq_size} ký tự`), kv('HTTP', e.status ?? e.error), kv('Thời gian', e.duration_ms !== null ? `${e.duration_ms} ms` : null),
      kv('Worker / tab', `${e.worker_id || ''} / ${e.tab_id ?? ''}`)),
    headers.length ? h('details', { style: { marginTop: '8px' } },
      h('summary', null, h('b', null, `Headers (${headers.length})`), custom.length ? h('span', { class: 'muted mono' }, ` · ${custom.join(', ')}`) : ''),
      h('div', { class: 'actions' }, h('button', { class: 'btn btn-sm', onclick: () => copy(headers.map((x) => `${x.name}: ${x.value}`).join('\n')) }, 'Copy headers')),
      h('pre', { class: 'body' }, headers.map((x) => `${x.name}: ${x.value}`).join('\n'))) : null,
    checkMount, ...blocks, h('div', { class: 'section-title' }, 'Response'), response);
}

export default {
  title: 'Observation',
  render(root) {
    const prefs = loadPref(PREFS, { q: '', rpcid: '', source: '', kind: '', hidePolls: true, paused: false });
    const persist = () => savePref(PREFS, prefs);
    const listEl = h('div');
    const chipsEl = h('div', { class: 'chips', style: { marginBottom: '10px' } });
    const meta = h('span', { class: 'muted' });
    const expanded = new Set();
    let rows = [];
    let reachedEnd = false;

    const rowView = (row) => {
      const isCaptcha = row.kind === 'recaptcha';
      const mount = h('div', { class: 'obs-detail' });
      const open = expanded.has(row.id);
      const el = h('div', { class: `obs-row${open ? ' open' : ''}` },
        h('div', { class: 'obs-sum', onclick: () => {
          if (expanded.has(row.id)) { expanded.delete(row.id); el.classList.remove('open'); fill(mount); }
          else { expanded.add(row.id); el.classList.add('open'); detail(row, mount); }
        } },
        h('div', { class: 'obs-head' },
          h('span', { class: 'mono muted' }, clock(row.ts)),
          ...(row.rpcids || []).map((r) => h('span', { class: `obs-rpc${known[r] || isCaptcha ? '' : ' new'}`, title: known[r]?.name || 'RPC chưa biết' }, r)),
          h('span', null, isCaptcha ? `reCAPTCHA ${(row.params || {}).endpoint || ''}` : (row.rpcids || []).map((r) => known[r]?.name || 'RPC mới').join(' + ')),
          h('span', { class: `obs-src ${row.source}` }, row.source === 'hub' ? 'Flow Hub' : 'Trang'),
          h('span', { class: `mono ${row.error || row.status >= 400 ? 'err' : 'ok'}` }, row.status ?? row.error ?? '…'),
          row.duration_ms !== null ? h('span', { class: 'muted' }, `${row.duration_ms}ms`) : null,
          row.has_response ? h('span', { class: 'ok', style: { fontSize: '11px' } }, 'resp') : null,
          (row.check_result || []).some((c) => c.supported && !c.ok) ? h('span', { class: 'err', style: { fontSize: '11px' } }, 'builder lệch') : null,
          (row.check_result || []).some((c) => c.ok) ? h('span', { class: 'ok', style: { fontSize: '11px' } }, 'builder khớp') : null),
        (row.summary?.keys?.length || row.summary?.prompt) ? h('div', { class: 'obs-sub' },
          row.summary.keys?.length ? h('span', { class: 'mono' }, row.summary.keys.slice(0, 8).join(' · ')) : null,
          row.summary.prompt ? h('div', null, `“${row.summary.prompt}”`) : null) : null),
        mount);
      if (open) detail(row, mount);
      return el;
    };

    const load = async (more = false) => {
      const q = new URLSearchParams({ limit: '150' });
      if (prefs.q) q.set('q', prefs.q);
      if (prefs.rpcid) q.set('rpcid', prefs.rpcid);
      if (prefs.source) q.set('source', prefs.source);
      if (prefs.kind) q.set('kind', prefs.kind);
      if (prefs.hidePolls) q.set('hide_polls', 'true');
      if (more && rows.length) q.set('before_id', rows[rows.length - 1].id);
      try {
        const batch = await api(`/api/observations?${q}`);
        rows = more ? rows.concat(batch) : batch;
        reachedEnd = batch.length < 150;
        fill(listEl, ...(rows.length ? rows.map(rowView) : [h('p', { class: 'empty' },
          'Chưa có request nào. Thao tác trên tab flow.google.com (có extension Flow Hub Worker) — mọi lệnh batchexecute sẽ hiện ở đây.')]),
        !reachedEnd ? h('button', { class: 'btn', onclick: () => load(true) }, 'Tải thêm') : null);
        meta.textContent = `${rows.length} dòng`;
      } catch (e) { fill(listEl, h('p', { class: 'err' }, e.message)); }
    };

    const loadKnown = async () => {
      const list = await api('/api/rpcs').catch(() => []);
      known = Object.fromEntries(list.filter((r) => r.name).map((r) => [r.rpcid, r]));
      const seen = list.filter((r) => r.count > 0);
      const chip = (value, label, extra = {}) => h('button', { class: `chip${prefs.rpcid === value ? ' active' : ''}${extra.isNew ? ' new' : ''}`,
        title: extra.title || '', onclick: () => { prefs.rpcid = value; persist(); loadKnown(); load(); } }, label, extra.n ? h('small', null, extra.n) : null);
      fill(chipsEl, chip('', 'Tất cả RPC'), ...seen.map((r) => chip(r.rpcid, r.rpcid,
        { n: r.count, isNew: !r.name, title: r.name || 'RPC chưa biết — có thể Flow vừa thêm' })), chip('reCAPTCHA', 'reCAPTCHA'));
    };

    const search = h('input', { class: 'input', placeholder: 'Tìm trong body: veo_, abra_, BELUGA, prompt, media id…', value: prefs.q,
      oninput: debounce((e) => { prefs.q = e.target.value.trim(); persist(); load(); }, 300) });
    const select = (key, options) => h('select', { class: 'input', style: { width: 'auto' }, onchange: (e) => { prefs[key] = e.target.value; persist(); load(); } },
      ...options.map(([v, l]) => h('option', { value: v, selected: prefs[key] === v }, l)));
    const toggle = (key, label, after) => h('label', { class: 'switch' }, h('input', { type: 'checkbox', checked: !!prefs[key],
      onchange: (e) => { prefs[key] = e.target.checked; persist(); after?.(); } }), label);

    root.append(
      h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'Observation'),
        h('p', null, 'Toàn bộ request batchexecute và lệnh mint reCAPTCHA mà tab Flow gửi (extension đọc thụ động). Request của trang được tự kiểm tra với builder; RPC/model/build mới sẽ báo ở Tổng quan.')),
      h('div', { class: 'actions' },
        h('a', { class: 'btn btn-sm', href: withKey('/api/observations/export'), download: '' }, 'Xuất JSON'),
        h('button', { class: 'btn btn-sm btn-danger', onclick: async (e) => {
          if (e.target.dataset.armed !== '1') { e.target.dataset.armed = '1'; e.target.textContent = 'Bấm lần nữa để xoá'; return; }
          await api('/api/observations', { method: 'DELETE' });
          e.target.dataset.armed = ''; e.target.textContent = 'Xoá log';
          load();
        } }, 'Xoá log'))),
      h('div', { class: 'filters' }, search,
        select('source', [['', 'Mọi nguồn'], ['page', 'Chỉ trang Flow'], ['hub', 'Chỉ Flow Hub']]),
        select('kind', [['', 'Mọi loại'], ['batchexecute', 'batchexecute'], ['recaptcha', 'reCAPTCHA']]),
        toggle('hidePolls', 'Ẩn poll', load), toggle('paused', 'Tạm dừng cập nhật', () => { if (!prefs.paused) load(); }), meta),
      chipsEl, listEl);
    loadKnown().then(load);
    this._reload = debounce(() => { if (!prefs.paused) { loadKnown(); load(); } }, 700);
  },
  onEvent(evt) {
    if (evt.type === 'observation' && !evt.data?.response) this._reload?.();
  },
};
