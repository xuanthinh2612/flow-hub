import { h, api, toast, openModal, closeModal, ago, statusPill, fmt, innerOf, mediaFile, debounce, $, fill } from '../core.js';
import { reuseSpec } from '../forms.js';

const TYPE_LABEL = { image: 'Ảnh', character: 'Nhân vật', edit: 'Sửa ảnh', t2v: 'Text → Video', i2v: 'Ảnh → Video',
  first_last: 'Đầu + cuối', r2v: 'Ingredients', upload: 'Upload', upscale: 'Upscale', template: 'Template' };
export const typeLabel = (t) => TYPE_LABEL[t] || t;

let openJobId = null;
const refreshOpenJob = debounce(() => { if (openJobId && $('#modal').open) openJob(openJobId); }, 400);

export function resultThumbs(job, onClick) {
  return h('div', { class: 'picker' }, ...(job.results || []).filter((r) => r.media_id).map((r) => h('div', {
    class: 'pick', title: r.media_id, style: { cursor: 'pointer' }, onclick: (e) => { e.stopPropagation(); onClick?.(r.media_id); },
  }, r.kind === 'video'
    ? (r.poster_url ? h('img', { src: r.poster_url, alt: '' }) : h('div', { class: 'noimg' }, '▶ video'))
    : h('img', { src: mediaFile(r.media_id), alt: '', loading: 'lazy' }))));
}

function rpcLogEntry(entry) {
  const inner = innerOf(entry.body || '');
  return h('div', { class: 'card', style: { padding: '10px' } },
    h('div', { class: 'obs-head' }, h('span', { class: 'obs-rpc' }, entry.rpcid),
      h('span', { class: 'muted' }, `captcha ${entry.captcha_action || '—'} · HTTP ${entry.status ?? '—'} · ${entry.duration_ms ?? '?'} ms · _reqid ${entry.reqid}`),
      entry.error ? h('span', { class: 'err' }, entry.error) : null),
    h('pre', { class: 'body' }, inner ? fmt(inner) : (entry.body || '')),
    entry.response ? h('details', null, h('summary', { class: 'muted' }, 'Response (rút gọn)'),
      h('pre', { class: 'body' }, entry.response)) : null);
}

export async function openJob(jobId) {
  openJobId = jobId;
  let job;
  try {
    job = await api(`/api/jobs/${jobId}`);
  } catch (e) {
    return toast(e.message, 'err');
  }
  const { openMedia } = await import('./library.js');
  const pending = (job.ops || []).filter((o) => !o.done);
  const act = async (path, label) => {
    try {
      await api(`/api/jobs/${jobId}/${path}`, { method: 'POST' });
      toast(label, 'ok');
      openJob(jobId);
    } catch (e) { toast(e.message, 'err'); }
  };
  openModal(`${typeLabel(job.type)} · ${job.id}`,
    h('div', { class: 'obs-head' }, statusPill(job.status), h('span', { class: 'mono' }, job.model || ''),
      h('span', { class: 'muted' }, `${ago(job.created_at)} · worker ${job.worker_id || '—'}`)),
    job.prompt ? h('p', null, job.prompt) : null,
    job.note ? h('p', { class: 'warn' }, job.note) : null,
    job.error ? h('p', { class: 'err' }, job.error) : null,
    ...(job.warnings || []).map((w) => h('p', { class: 'warn', style: { margin: '2px 0' } }, `⚠ ${w}`)),
    job.results?.length ? [h('div', { class: 'section-title' }, 'Kết quả'), resultThumbs(job, (id) => openMedia(id))] : null,
    job.ops?.length ? [h('div', { class: 'section-title' }, 'Operation'),
      h('table', { class: 'list' }, h('tr', null, h('th', null, ''), h('th', null, 'Operation'), h('th', null, 'Trạng thái'), h('th', null, 'Vòng poll'), h('th', null, 'Ghi chú')),
        ...job.ops.map((o) => h('tr', null, h('td', null, o.done ? '✓' : '…'), h('td', { class: 'mono' }, `${o.label} · ${o.id}`),
          h('td', null, o.status || '—'), h('td', null, o.rounds || 0), h('td', { class: 'muted' }, o.complaint || ''))))] : null,
    h('div', { class: 'actions' },
      ['queued', 'running', 'polling'].includes(job.status)
        ? h('button', { class: 'btn btn-sm', onclick: () => act('cancel', 'Đã huỷ') }, 'Huỷ') : null,
      pending.length && !['queued', 'running', 'polling'].includes(job.status)
        ? h('button', { class: 'btn btn-sm', onclick: () => act('repoll', 'Đang kiểm tra lại') }, 'Kiểm tra lại') : null,
      reuseSpecPossible(job) ? h('button', { class: 'btn btn-sm', onclick: () => {
        const page = reuseSpec(job.spec);
        closeModal();
        location.hash = `#/${page}`;
      } }, 'Dùng lại cài đặt') : null,
      h('button', { class: 'btn btn-sm btn-danger', onclick: async () => {
        await api(`/api/jobs/${jobId}`, { method: 'DELETE' });
        closeModal();
        toast('Đã xoá job', 'ok');
      } }, 'Xoá')),
    h('div', { class: 'section-title' }, `Request đã gửi (${job.rpc_log?.length || 0})`),
    ...(job.rpc_log || []).map(rpcLogEntry),
    h('details', null, h('summary', { class: 'muted' }, 'Spec (JSON)'), h('pre', { class: 'body' }, JSON.stringify(job.spec, null, 2))));
}

const reuseSpecPossible = (job) => ['image', 'edit', 'character', 't2v', 'i2v', 'first_last', 'r2v'].includes(job.type);

export function jobTable(jobs) {
  if (!jobs.length) return h('p', { class: 'empty' }, 'Chưa có job nào.');
  return h('table', { class: 'list' },
    h('tr', null, ...['Thời gian', 'Loại', 'Model', 'Prompt', 'Trạng thái', ''].map((t) => h('th', null, t))),
    ...jobs.map((j) => h('tr', { class: 'click', onclick: () => openJob(j.id) },
      h('td', { class: 'muted', style: { whiteSpace: 'nowrap' } }, ago(j.created_at)),
      h('td', null, typeLabel(j.type)),
      h('td', { class: 'mono' }, j.model || ''),
      h('td', null, h('div', { class: 'clamp' }, j.prompt || '')),
      h('td', null, statusPill(j.status), j.error ? h('div', { class: 'err clamp', style: { fontSize: '12px' } }, j.error) : null),
      h('td', null, resultThumbs(j)))));
}

export default {
  title: 'Jobs',
  render(root) {
    let filter = 'all';
    const list = h('div', { class: 'card' }, h('p', { class: 'empty' }, 'Đang tải…'));
    const load = async () => {
      const q = filter === 'all' ? '' : `status=${filter}&`;
      try {
        fill(list, jobTable(await api(`/api/jobs?${q}limit=200`)));
      } catch (e) { fill(list, h('p', { class: 'err' }, e.message)); }
    };
    const chips = ['all', 'active', 'done', 'partial', 'failed', 'timeout', 'canceled'];
    const seg = h('div', { class: 'seg' }, ...chips.map((c) => h('button', {
      class: `chip${c === filter ? ' active' : ''}`,
      onclick: (e) => { filter = c; [...seg.children].forEach((b) => b.classList.remove('active')); e.target.classList.add('active'); load(); },
    }, c === 'all' ? 'Tất cả' : c === 'active' ? 'Đang chạy' : c)));
    root.append(h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'Jobs'),
      h('p', null, 'Mọi lệnh tạo đã gửi qua worker. Bấm một dòng để xem body, response và trạng thái từng operation.'))), seg, list);
    load();
    this._reload = debounce(load, 500);
  },
  onEvent(evt) {
    if (evt.type !== 'job') return;
    this._reload?.();
    if (openJobId && evt.data?.id === openJobId && $('#modal').open) refreshOpenJob();
  },
};
