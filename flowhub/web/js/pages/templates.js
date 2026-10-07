import { h, api, toast, fmt, ago, field, fill } from '../core.js';

export default {
  title: 'Templates & RPC',
  render(root) {
    const listEl = h('div');
    const editor = h('div', { class: 'card' }, h('p', { class: 'empty' }, 'Chọn một template bên trái, hoặc tạo từ một request trong Observation.'));
    const wanted = Number(new URLSearchParams(location.hash.split('?')[1] || '').get('id')) || null;

    const open = async (id) => {
      let t;
      try { t = await api(`/api/templates/${id}`); } catch (e) { return toast(e.message, 'err'); }
      const draft = { name: t.name, rpcid: t.rpcid, captcha_action: t.captcha_action || '', result_kind: t.result_kind, note: t.note || '' };
      const inner = h('textarea', { class: 'input code', rows: 16, value: JSON.stringify(t.inner, null, 1) });
      const vars = {};
      const varInputs = h('div');
      const out = h('pre', { class: 'body', hidden: true });
      const renderVars = (names) => fill(varInputs, ...names.filter((n) => n !== 'project_id').map((n) => field(n,
        n === 'prompt' ? h('textarea', { class: 'input', rows: 2, oninput: (e) => { vars[n] = e.target.value; } })
          : h('input', { class: 'input mono', placeholder: n === 'seed' ? 'trống = ngẫu nhiên' : 'media id…', oninput: (e) => { vars[n] = e.target.value; } }))));
      renderVars(t.variables || []);
      const text = (key, label) => field(label, h('input', { class: 'input', value: draft[key], oninput: (e) => { draft[key] = e.target.value; } }));
      const parseInner = () => {
        try { return JSON.parse(inner.value); } catch (e) { throw new Error(`inner không phải JSON hợp lệ: ${e.message}`); }
      };
      fill(editor, 
        h('h2', null, `Template #${t.id}`),
        h('p', { class: 'hint' }, `${t.note || ''} · tạo ${ago(t.created_at)}${t.observation_id ? ` · từ observation #${t.observation_id}` : ''}`),
        h('div', { class: 'grid-2' }, text('name', 'Tên'), text('rpcid', 'RPC id'),
          field('Captcha action (trống = không captcha)', h('input', { class: 'input mono', value: draft.captcha_action, oninput: (e) => { draft.captcha_action = e.target.value; } })),
          field('Kết quả', h('select', { class: 'input', onchange: (e) => { draft.result_kind = e.target.value; } },
            ...['image', 'video', 'raw'].map((k) => h('option', { value: k, selected: draft.result_kind === k }, k))))),
        field(h('span', null, 'Inner JSON — placeholder: ', h('span', { class: 'mono' }, '{{prompt}} {{project_id}} {{uuid}} {{seed}} {{media_N}} "__CAPTCHA__"')), inner),
        h('div', { class: 'actions' },
          h('button', { class: 'btn', onclick: async () => {
            try {
              const saved = await api(`/api/templates/${t.id}`, { method: 'PATCH', body: { ...draft, captcha_action: draft.captcha_action || null, inner: parseInner() } });
              renderVars(saved.variables || []);
              toast('Đã lưu template', 'ok');
              loadList();
            } catch (e) { toast(e.message, 'err'); }
          } }, 'Lưu'),
          h('button', { class: 'btn btn-danger', onclick: async () => {
            await api(`/api/templates/${t.id}`, { method: 'DELETE' });
            fill(editor, h('p', { class: 'empty' }, 'Đã xoá.'));
            loadList();
          } }, 'Xoá')),
        h('div', { class: 'section-title' }, 'Chạy template'),
        varInputs,
        h('div', { class: 'actions' },
          h('button', { class: 'btn btn-primary', onclick: async () => {
            try {
              const job = await api('/api/jobs', { method: 'POST', body: { type: 'template', template_id: t.id, prompt: vars.prompt || null, variables: vars } });
              toast(`Đã gửi job ${job.id} — xem ở Jobs`, 'ok');
            } catch (e) { toast(e.message, 'err'); }
          } }, 'Chạy'),
          h('button', { class: 'btn', onclick: async () => {
            try {
              const r = await api(`/api/templates/${t.id}/render`, { method: 'POST', body: { variables: { prompt: 'PROMPT', ...vars } } });
              out.textContent = `${r.rpcid}\ninner =\n${fmt(r.inner)}`;
              out.hidden = false;
            } catch (e) { out.textContent = `⚠ ${e.message}`; out.hidden = false; }
          } }, 'Xem body')),
        out);
    };

    const loadList = async () => {
      const items = await api('/api/templates').catch(() => []);
      fill(listEl, ...(items.length ? items.map((t) => h('div', { class: 'obs-row', style: { cursor: 'pointer' }, onclick: () => open(t.id) },
        h('div', { class: 'obs-sum' }, h('div', { class: 'obs-head' }, h('span', { class: 'obs-rpc' }, t.rpcid), h('b', null, t.name)),
          h('div', { class: 'obs-sub' }, `biến: ${(t.variables || []).join(', ') || '—'} · ${t.result_kind} · ${ago(t.updated_at)}`))))
        : [h('p', { class: 'empty' }, 'Chưa có template. Mở Observation → một request của trang → "Tạo template từ request này".')]));
    };

    // raw RPC console
    const raw = { rpcid: 'as29s', inner: '["<media id>"]', captcha: '' };
    const rawOut = h('pre', { class: 'body', hidden: true });
    const console_ = h('div', { class: 'card' }, h('h2', null, 'Gửi RPC thủ công'),
      h('p', { class: 'hint' }, 'Gửi một RPC bất kỳ qua worker để thử khi Flow đổi API. Body có "__CAPTCHA__" sẽ được mint token (action tự chọn theo RPC nếu để trống).'),
      h('div', { class: 'grid-2' },
        field('RPC id', h('input', { class: 'input mono', value: raw.rpcid, oninput: (e) => { raw.rpcid = e.target.value.trim(); } })),
        field('Captcha action', h('input', { class: 'input mono', placeholder: 'trống = tự chọn · none = không', oninput: (e) => { raw.captcha = e.target.value.trim(); } }))),
      field('Inner JSON', h('textarea', { class: 'input code', rows: 6, value: raw.inner, oninput: (e) => { raw.inner = e.target.value; } })),
      h('div', { class: 'actions' }, h('button', { class: 'btn btn-primary', onclick: async () => {
        let inner;
        try { inner = JSON.parse(raw.inner); } catch (e) { return toast(`inner không phải JSON: ${e.message}`, 'err'); }
        rawOut.hidden = false;
        rawOut.textContent = 'Đang gửi…';
        try {
          const r = await api('/api/rpc', { method: 'POST', body: { rpcid: raw.rpcid, inner, captcha_action: raw.captcha || null } });
          rawOut.textContent = `HTTP ${r.status ?? '—'}${r.error ? ` · lỗi ${r.error}` : ''}\n\n`
            + (r.decoded ? (r.decoded.rpcs || []).map((x) => `${x.rpcid}${x.error_text ? ` · LỖI ${x.error_text}` : ''}\n${x.data !== undefined ? fmt(x.data) : ''}`).join('\n\n') : '')
            + `\n\nRaw:\n${r.text || ''}`;
        } catch (e) { rawOut.textContent = `⚠ ${e.message}`; }
      } }, 'Gửi')), rawOut);

    root.append(h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'Templates & RPC'),
      h('p', null, 'Khi Flow đổi body trước khi kịp sửa builder: lấy một request thật của trang làm template rồi chạy với prompt mới.'))),
    h('div', { class: 'cols' }, h('div', null, h('div', { class: 'card' }, h('h2', null, 'Templates'), listEl), console_), editor));
    loadList();
    if (wanted) open(wanted);
  },
};
