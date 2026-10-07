import { h, api, toast, openModal, closeModal, ago, mediaFile, mediaVisual, copy, invalidateMedia, debounce, withKey, fill } from '../core.js';
import { useMediaIn } from '../forms.js';

const USES = [
  { label: 'Tham chiếu cho Ảnh', page: 'image', field: 'refs' },
  { label: 'Ảnh gốc để sửa', page: 'image', field: 'base', multi: false, patch: { mode: 'edit' } },
  { label: 'Ảnh đầu (Ảnh → Video)', page: 'video', field: 'starts', patch: { mode: 'i2v' } },
  { label: 'Ảnh đầu (đầu + cuối)', page: 'video', field: 'start', multi: false, patch: { mode: 'first_last' } },
  { label: 'Ảnh cuối (đầu + cuối)', page: 'video', field: 'end', multi: false, patch: { mode: 'first_last' } },
  { label: 'Ingredient (Omni)', page: 'video', field: 'refs', patch: { mode: 'r2v' } },
];

export async function openMedia(mediaId) {
  let m;
  try {
    m = await api(`/api/media/${encodeURIComponent(mediaId)}`);
  } catch (e) {
    return toast(e.message, 'err');
  }
  const isVideo = m.kind === 'video';
  const view = isVideo
    ? h('video', { class: 'media-view', src: mediaFile(m.id), controls: true })
    : h('img', { class: 'media-view', src: mediaFile(m.id), alt: '' });
  const row = (k, v) => (v ? [h('dt', null, k), h('dd', null, String(v))] : []);
  const upscale = async (res) => {
    try {
      const job = await api('/api/jobs', { method: 'POST', body: { type: 'upscale', media_id: m.id, resolution: res } });
      toast(`Đã gửi upscale ${res} (job ${job.id})`, 'ok');
    } catch (e) { toast(e.message, 'err'); }
  };
  openModal(isVideo ? 'Video' : 'Ảnh', view,
    h('dl', { class: 'kv', style: { marginTop: '10px' } },
      row('Media ID', m.id), row('Nguồn', m.source), row('Model', m.model), row('Prompt', m.prompt),
      row('Tỉ lệ', m.aspect), row('Job', m.job_id), row('File trên server', m.local_path ? `${m.mime} · ${Math.round((m.size || 0) / 1024)} KB` : 'chưa tải về'),
      row('Tạo lúc', m.created_at ? new Date(m.created_at * 1000).toLocaleString('vi-VN') : ''), row('Ghi chú', m.note)),
    h('div', { class: 'actions' },
      h('button', { class: 'btn btn-sm', onclick: () => copy(m.id, 'Đã copy media ID') }, 'Copy media ID'),
      h('a', { class: 'btn btn-sm', href: withKey(`/api/media/${encodeURIComponent(m.id)}/file?download=true`), download: '' }, 'Tải xuống'),
      h('button', { class: 'btn btn-sm', onclick: async () => {
        try { await api(`/api/media/${encodeURIComponent(m.id)}/refresh`, { method: 'POST' }); toast('Đã làm mới URL', 'ok'); openMedia(m.id); } catch (e) { toast(e.message, 'err'); }
      } }, 'Làm mới URL (as29s)'),
      h('button', { class: 'btn btn-sm btn-danger', onclick: async () => {
        await api(`/api/media/${encodeURIComponent(m.id)}`, { method: 'DELETE' });
        invalidateMedia();
        closeModal();
        toast('Đã xoá khỏi thư viện', 'ok');
      } }, 'Xoá')),
    isVideo ? null : [
      h('div', { class: 'section-title' }, 'Dùng cho'),
      h('div', { class: 'actions' }, ...USES.map((u) => h('button', { class: 'btn btn-sm', onclick: () => {
        useMediaIn(u.page, u.field, m.id, { multi: u.multi !== false, patch: u.patch });
        closeModal();
        location.hash = `#/${u.page}`;
        toast(`Đã thêm vào: ${u.label}`, 'ok');
      } }, u.label))),
      h('div', { class: 'section-title' }, 'Upscale (SPrCad)'),
      h('div', { class: 'actions' }, h('button', { class: 'btn btn-sm', onclick: () => upscale('2K') }, 'Upscale 2K'),
        h('button', { class: 'btn btn-sm', onclick: () => upscale('4K') }, 'Upscale 4K')),
    ]);
}

export default {
  title: 'Thư viện',
  render(root) {
    let filter = { kind: '', source: '' };
    const grid = h('div', { class: 'tiles' });
    const load = async () => {
      const q = new URLSearchParams({ limit: '500', ...(filter.kind ? { kind: filter.kind } : {}), ...(filter.source ? { source: filter.source } : {}) });
      const items = await api(`/api/media?${q}`).catch(() => []);
      fill(grid, ...(items.length ? items.map((m) => h('div', { class: 'tile', title: m.prompt || m.id, onclick: () => openMedia(m.id) },
        mediaVisual(m), m.kind === 'video' ? h('span', { class: 'badge-v' }, '▶ video') : null,
        h('div', { class: 'meta' }, h('span', null, m.source || ''), h('span', null, ago(m.created_at)))))
        : [h('p', { class: 'empty' }, 'Chưa có media nào.')]));
    };
    const filters = [
      ['Tất cả', {}], ['Ảnh', { kind: 'image' }], ['Video', { kind: 'video' }], ['Nhân vật', { source: 'character' }],
      ['Upload', { source: 'upload' }], ['Upscale', { source: 'upscale' }],
    ];
    const seg = h('div', { class: 'seg' }, ...filters.map(([label, f], i) => h('button', {
      class: `chip${i === 0 ? ' active' : ''}`,
      onclick: (e) => { filter = { kind: '', source: '', ...f }; [...seg.children].forEach((b) => b.classList.remove('active')); e.target.classList.add('active'); load(); },
    }, label)));
    const file = h('input', { type: 'file', accept: 'image/jpeg,image/png,image/webp,image/gif', multiple: true, hidden: true,
      onchange: async (e) => {
        for (const f of [...e.target.files]) {
          const form = new FormData();
          form.append('file', f);
          try {
            const job = await api('/api/uploads', { method: 'POST', form });
            toast(`Đang upload ${f.name} (job ${job.id})`, 'ok');
          } catch (err) { toast(`${f.name}: ${err.message}`, 'err'); }
        }
        e.target.value = '';
      } });
    const idInput = h('input', { class: 'input mono', placeholder: 'media ID có sẵn trong project Flow', spellcheck: 'false' });
    root.append(
      h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'Thư viện'),
        h('p', null, 'Mọi ảnh / video đã tạo, upload hoặc thêm bằng ID. Bấm vào để xem, tải, upscale hoặc dùng làm tham chiếu.'))),
      h('div', { class: 'card' }, h('div', { class: 'inline' },
        h('label', { class: 'btn btn-primary' }, 'Tải ảnh lên Flow', file), idInput,
        h('button', { class: 'btn', onclick: async () => {
          const id = idInput.value.trim();
          if (!id) return;
          try { await api('/api/media', { method: 'POST', body: { media_id: id } }); idInput.value = ''; toast('Đã thêm', 'ok'); load(); } catch (e) { toast(e.message, 'err'); }
        } }, 'Thêm theo ID'))),
      h('div', { style: { height: '12px' } }), seg, grid);
    load();
    this._reload = debounce(load, 600);
  },
  onEvent(evt) {
    if (evt.type === 'media') this._reload?.();
  },
};
