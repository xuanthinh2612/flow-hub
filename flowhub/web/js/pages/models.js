import { h, api, toast, ago, debounce, fill } from '../core.js';

const ASPECT_LABEL = { landscape: '16:9', portrait: '9:16' };

export default {
  title: 'Models',
  render(root) {
    const body = h('div', null, h('p', { class: 'empty' }, 'Đang tải…'));
    const load = async () => {
      let data;
      try { data = await api('/api/models'); } catch (e) { fill(body, h('p', { class: 'err' }, e.message)); return; }
      const byMode = {};
      for (const f of data.families) (byMode[f.mode] = byMode[f.mode] || []).push(f);
      fill(body, ...Object.entries(data.modes).map(([mode, label]) => h('div', { class: 'card' },
        h('h2', null, label),
        ...(byMode[mode] || []).map((fam) => h('div', { style: { marginBottom: '14px' } },
          h('div', { class: 'obs-head', style: { marginBottom: '6px' } },
            h('b', null, fam.label), h('span', { class: 'mono muted' }, fam.family),
            fam.default ? h('span', { class: 'status done' }, 'mặc định')
              : h('button', { class: 'btn btn-sm btn-ghost', onclick: async () => {
                await api('/api/models/default', { method: 'POST', body: { mode, family: fam.family } });
                toast(`${fam.label} là mặc định cho ${mode}`, 'ok');
                load();
              } }, 'Đặt mặc định')),
          h('table', { class: 'list' },
            h('tr', null, ...['Wire id', 'Tỉ lệ', 'Thời lượng', 'Độ phân giải', 'Trạng thái', 'Nguồn', 'Ghi chú', ''].map((t) => h('th', null, t))),
            ...fam.variants.map((v) => h('tr', { style: v.source === 'observed' ? { background: 'color-mix(in srgb, var(--warn) 8%, transparent)' } : null },
              h('td', { class: 'mono' }, v.key),
              h('td', null, v.aspect ? ASPECT_LABEL[v.aspect] || v.aspect : 'mọi'),
              h('td', null, v.duration ? `${v.duration}s` : '—'),
              h('td', null, v.resolution || '—'),
              h('td', null, h('select', { class: 'input', style: { width: 'auto', padding: '2px 6px' }, onchange: async (e) => {
                await api(`/api/models/${v.id}`, { method: 'PATCH', body: { status: e.target.value } });
                toast(`${v.key}: ${e.target.value}`, 'ok');
              } }, ...['verified', 'unverified', 'disabled'].map((s) => h('option', { value: s, selected: v.status === s }, s)))),
              h('td', { class: 'muted' }, v.source === 'observed' ? `thấy trên Flow ${ago(v.first_seen)}` : v.source),
              h('td', { class: 'muted', style: { fontSize: '12px' } }, v.note || '', v.last_seen ? h('div', null, `lần cuối: ${ago(v.last_seen)}`) : null),
              h('td', null, h('button', { class: 'btn btn-sm btn-ghost btn-danger', onclick: async () => {
                await api(`/api/models/${v.id}`, { method: 'DELETE' });
                load();
              } }, 'Xoá'))))))),
        !(byMode[mode] || []).length ? h('p', { class: 'muted' }, 'Chưa có model nào.') : null)));
    };

    const f = { mode: 't2v', family: '', family_label: '', key: '', aspect: '', duration: '', resolution: '', status: 'unverified', note: '' };
    const input = (key, placeholder) => h('input', { class: 'input mono', placeholder, oninput: (e) => { f[key] = e.target.value.trim(); } });
    const sel = (key, options) => h('select', { class: 'input', onchange: (e) => { f[key] = e.target.value; } },
      ...options.map(([v, l]) => h('option', { value: v, selected: f[key] === v }, l)));
    const add = h('div', { class: 'card' }, h('h2', null, 'Thêm model thủ công'),
      h('p', { class: 'hint' }, 'Model mà trang Flow dùng sẽ tự xuất hiện ở đây (nguồn "observed"). Chỉ cần thêm tay khi muốn thử một wire id trước khi thấy nó trong traffic.'),
      h('div', { class: 'grid-2' },
        sel('mode', [['image', 'image'], ['t2v', 't2v'], ['i2v', 'i2v'], ['first_last', 'first_last'], ['r2v', 'r2v']]),
        input('key', 'wire id, VD: veo_3_1_t2v_quality'),
        input('family', 'family (trống = theo wire id)'), input('family_label', 'tên hiển thị'),
        sel('aspect', [['', 'mọi tỉ lệ'], ['landscape', '16:9'], ['portrait', '9:16']]),
        input('duration', 'thời lượng (s), VD 8'),
        sel('resolution', [['', 'không'], ['720p', '720p'], ['360p', '360p']]),
        sel('status', [['unverified', 'unverified'], ['verified', 'verified']])),
      h('div', { class: 'actions' }, h('button', { class: 'btn btn-primary', onclick: async () => {
        const payload = Object.fromEntries(Object.entries(f).filter(([, v]) => v !== ''));
        if (payload.duration) payload.duration = Number(payload.duration);
        try { await api('/api/models', { method: 'POST', body: payload }); toast('Đã thêm', 'ok'); load(); } catch (e) { toast(e.message, 'err'); }
      } }, 'Thêm')));

    root.append(h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'Models'),
      h('p', null, 'Danh mục wire id theo chế độ. Job chọn theo family + tỉ lệ/thời lượng/độ phân giải; "verified" = đã thấy trang Flow dùng.'))),
    body, add);
    load();
    this._reload = debounce(load, 800);
  },
  onEvent(evt) { if (evt.type === 'alert') this._reload?.(); },
};
