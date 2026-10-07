import { h, api, ago, debounce, fill } from '../core.js';
import { jobTable } from './jobs.js';

const KIND_LABEL = { rpc_new: 'RPC mới', model_new: 'Model mới', model_verified: 'Xác minh', build: 'Build',
  builder_drift: 'Builder lệch', captcha_action: 'Captcha', observe: 'Observation' };

export default {
  title: 'Tổng quan',
  render(root) {
    const body = h('div', null, h('p', { class: 'empty' }, 'Đang tải…'));
    const load = async () => {
      let o;
      try { o = await api('/api/overview'); } catch (e) { fill(body, h('p', { class: 'err' }, e.message)); return; }
      const online = o.workers.filter((w) => w.online);
      const active = (o.job_counts.queued || 0) + (o.job_counts.running || 0) + (o.job_counts.polling || 0);
      const stat = (v, k, cls = '') => h('div', { class: 'stat' }, h('div', { class: `v ${cls}` }, v), h('div', { class: 'k' }, k));
      fill(body, 
        h('div', { class: 'stats' },
          stat(online.length, 'worker online', online.length ? 'ok' : 'err'), stat(active, 'job đang chạy', active ? 'warn' : ''),
          stat(o.job_counts.done || 0, 'job xong'), stat(o.job_counts.failed || 0, 'job lỗi', o.job_counts.failed ? 'err' : ''),
          stat(o.media_count, 'media'), stat(o.observation_count, 'observation')),
        !online.length ? h('div', { class: 'card', style: { borderColor: 'var(--warn)' } }, h('h2', null, 'Chưa có worker nào kết nối'),
          h('p', null, 'Cài extension trong thư mục ', h('span', { class: 'mono' }, 'extension/'), ' (chrome://extensions → Developer mode → Load unpacked), mở popup và dán URL + token ở trang ',
            h('a', { href: '#/settings' }, 'Cài đặt'), '. Sau đó mở flow.google.com, đăng nhập và vào một project.')) : null,
        h('div', { class: 'cols' },
          h('div', null,
            h('div', { class: 'card' }, h('h2', null, 'Workers'),
              ...(o.workers.length ? o.workers.map((w) => h('div', { class: 'alert-row' },
                h('span', { class: `pill ${w.online ? 'ok' : 'err'}` }, w.online ? '● online' : '○ offline'),
                h('div', null, h('b', null, w.label), h('span', { class: 'muted mono' }, ` ${w.id.slice(0, 8)} · v${w.version || '?'}`),
                  h('div', { class: 'muted', style: { fontSize: '12px' } },
                    `${w.flow?.tabs || 0} tab Flow · project ${(w.flow?.projects || [])[0]?.projectId || '—'} · ${w.online ? `kết nối ${ago(w.connected_at)}` : `lần cuối ${ago(w.last_seen)}`}`
                    + (w.stats?.rpcs !== undefined ? ` · ${w.stats.rpcs} RPC, ${w.stats.observed} quan sát` : '')))))
                : [h('p', { class: 'muted' }, 'Chưa có.')])),
            h('div', { class: 'card' }, h('h2', null, 'Job gần đây'), jobTable(o.recent_jobs))),
          h('div', { class: 'card' },
            h('div', { class: 'obs-head', style: { justifyContent: 'space-between', marginBottom: '6px' } },
              h('h2', { style: { margin: 0 } }, `Cảnh báo thay đổi của Flow${o.alerts_unseen ? ` (${o.alerts_unseen} mới)` : ''}`),
              o.alerts_unseen ? h('button', { class: 'btn btn-sm', onclick: async () => {
                await api('/api/alerts/seen', { method: 'POST', body: {} });
                load();
              } }, 'Đánh dấu đã xem') : null),
            h('p', { class: 'hint' }, `Build Flow gần nhất: ${o.last_build || 'chưa thấy'} — cảnh báo khi trang dùng RPC/model/build mới hoặc builder lệch với request thật.`),
            ...(o.alerts.length ? o.alerts.map((a) => h('div', { class: `alert-row${a.seen ? ' seen' : ''}` },
              h('span', { class: 'kind' }, KIND_LABEL[a.kind] || a.kind),
              h('div', null, h('b', null, a.title), a.detail ? h('div', { class: 'muted', style: { fontSize: '12px' } }, a.detail) : null,
                h('div', { class: 'muted', style: { fontSize: '11px' } }, ago(a.ts)))))
              : [h('p', { class: 'muted' }, 'Chưa có cảnh báo — Flow chưa thay đổi gì so với những gì Flow Hub biết.')]))));
    };
    root.append(h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'Tổng quan'),
      h('p', null, 'Trạng thái worker, job và những thay đổi của Flow mà Observation phát hiện.'))), body);
    load();
    this._reload = debounce(load, 600);
  },
  onEvent(evt) {
    if (['worker', 'job', 'alert'].includes(evt.type)) this._reload?.();
  },
};
