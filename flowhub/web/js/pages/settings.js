import { h, api, toast, copy, field, fill } from '../core.js';

export default {
  title: 'Cài đặt',
  render(root) {
    const body = h('div', null, h('p', { class: 'empty' }, 'Đang tải…'));
    const load = async () => {
      let s;
      let workers;
      try {
        [s, workers] = await Promise.all([api('/api/settings'), api('/api/workers')]);
      } catch (e) { fill(body, h('p', { class: 'err' }, e.message)); return; }
      const draft = {};
      const projects = [...new Set(workers.flatMap((w) => (w.flow?.projects || []).map((p) => p.projectId)))];
      const num = (key, label, hint) => field(label, h('input', { class: 'input', type: 'number', value: s[key], step: 'any',
        oninput: (e) => { draft[key] = Number(e.target.value); } }), hint ? h('p', { class: 'hint' }, hint) : null);
      const check = (key, label, hint) => h('div', { class: 'field' }, h('label', { class: 'switch' },
        h('input', { type: 'checkbox', checked: !!s[key], onchange: (e) => { draft[key] = e.target.checked; } }), label),
        hint ? h('p', { class: 'hint' }, hint) : null);
      const projectInput = h('input', { class: 'input mono', value: s.project_id || '', placeholder: 'trống = dùng project đang mở trên tab Flow của worker',
        oninput: (e) => { draft.project_id = e.target.value.trim(); } });
      const curl = `curl -X POST http://${location.host}/api/jobs -H "Content-Type: application/json"${s.auth_enabled ? ' -H "X-API-Key: <API key>"' : ''} \\\n  -d '{"type":"t2v","prompt":"một cô gái đàn hát bên cửa sổ","aspect":"16:9"}'`;
      fill(body, 
        h('div', { class: 'cols' },
          h('div', null,
            h('div', { class: 'card' }, h('h2', null, 'Ghép nối extension (worker)'),
              h('p', { class: 'hint' }, 'Mở popup của extension "Flow Hub Worker" → dán 2 giá trị dưới → Lưu & kết nối.'),
              field('URL WebSocket', h('div', { class: 'inline' }, h('input', { class: 'input mono', value: s.ws_url, readonly: true }),
                h('button', { class: 'btn btn-sm', onclick: () => copy(s.ws_url) }, 'Copy'))),
              field('Token', h('div', { class: 'inline' }, h('input', { class: 'input mono', value: s.worker_token, readonly: true, type: 'password',
                onfocus: (e) => { e.target.type = 'text'; } }),
              h('button', { class: 'btn btn-sm', onclick: () => copy(s.worker_token, 'Đã copy token') }, 'Copy'),
              s.worker_token_from_env ? null : h('button', { class: 'btn btn-sm btn-danger', onclick: async () => {
                await api('/api/settings/rotate-worker-token', { method: 'POST' });
                toast('Đã đổi token — dán token mới vào extension', 'ok');
                load();
              } }, 'Đổi token'))),
              h('p', { class: 'hint' }, `Worker đang kết nối: ${workers.filter((w) => w.online).map((w) => w.label).join(', ') || 'chưa có'}`)),
            h('div', { class: 'card' }, h('h2', null, 'API cho server khác'),
              h('p', { class: 'hint' }, s.auth_enabled ? 'Xác thực: BẬT — gửi header X-API-Key (key in ra console khi server khởi động, hoặc FLOWHUB_API_KEY trong .env).'
                : 'Xác thực: TẮT (server chỉ nghe trên localhost). Đặt FLOWHUB_AUTH=on hoặc mở ra mạng ngoài sẽ tự bật.'),
              h('pre', { class: 'body' }, curl),
              h('p', null, h('a', { href: '/docs', target: '_blank' }, 'Mở tài liệu API (Swagger) ↗'), ' — webhook: thêm "webhook_url" vào job, server POST kết quả khi xong.'))),
          h('div', { class: 'card' }, h('h2', null, 'Tuỳ chọn'),
            field('Flow project ID mặc định', projectInput,
              projects.length ? h('div', { class: 'chips', style: { marginTop: '6px' } }, ...projects.map((p) => h('button', { class: 'chip mono',
                onclick: () => { projectInput.value = p; draft.project_id = p; } }, p))) : h('p', { class: 'hint' }, 'Chưa thấy project nào trên tab Flow của worker.')),
            check('observe_enabled', 'Ghi Observation (request của trang Flow)'),
            check('observe_responses', 'Ghi cả response (chrome.debugger)', 'Chrome sẽ hiện thanh "đang debug trình duyệt" trên máy worker; đóng thanh đó = tự tắt.'),
            check('download_media', 'Tải ảnh / video về server khi xong'),
            h('div', { class: 'grid-2' },
              num('poll_interval_s', 'Chu kỳ poll video (giây)', 'Giao diện Flow dùng ~5 giây'),
              num('min_submit_gap_s', 'Giãn cách giữa các lệnh tạo (giây)', 'Không bắn liên tục — giảm rủi ro "unusual activity"'),
              num('job_timeout_min', 'Timeout video mặc định (phút)'),
              num('wait_worker_s', 'Chờ worker tối đa (giây)'),
              num('max_observations', 'Giữ tối đa bao nhiêu observation')),
            h('div', { class: 'actions' }, h('button', { class: 'btn btn-primary', onclick: async () => {
              try { await api('/api/settings', { method: 'PATCH', body: draft }); toast('Đã lưu', 'ok'); load(); } catch (e) { toast(e.message, 'err'); }
            } }, 'Lưu')),
            h('p', { class: 'hint' }, `Flow Hub ${s.version} · build Flow gần nhất: ${s.last_build || 'chưa thấy'}`))));
    };
    root.append(h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'Cài đặt'),
      h('p', null, 'Ghép nối extension, project mặc định, Observation và API.'))), body);
    load();
  },
};
