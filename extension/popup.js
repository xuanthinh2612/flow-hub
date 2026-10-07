const $ = (id) => document.getElementById(id);

const STATE_LABEL = {
  open: ['● đã kết nối', 'ok'],
  connecting: ['… đang kết nối', 'warn'],
  off: ['○ mất kết nối', 'err'],
  rejected: ['✕ sai token', 'err'],
  unconfigured: ['○ chưa cấu hình', 'warn'],
};

function send(type, extra = {}) {
  return new Promise((resolve) => chrome.runtime.sendMessage({ type, ...extra }, (r) => resolve(r || {})));
}

let filled = false;

async function refresh() {
  const s = await send('STATUS');
  if (!s.cfg) return;
  const [label, cls] = STATE_LABEL[s.state] || [s.state, ''];
  $('state').textContent = label;
  $('state').className = `pill ${cls}`;
  $('worker-id').textContent = (s.workerId || '').slice(0, 13) + '…';
  $('flow').textContent = s.flow?.tabs ? `${s.flow.tabs} tab (${s.flow.live} đang chạy)` : 'chưa mở tab flow.google.com';
  $('project').textContent = s.flow?.projects?.[0]?.projectId || 'chưa mở project';
  $('rpcs').textContent = `${s.stats?.rpcs || 0} (lỗi ${s.stats?.rpcErrors || 0})`;
  $('observed').textContent = `${s.stats?.observed || 0}${s.observe?.responses ? ' · có response' : ''}`;
  $('error').hidden = !s.lastError;
  $('error').textContent = s.lastError || '';
  $('token-hint').textContent = s.hasToken ? `(đã lưu ${s.cfg.token})` : '';
  if (!filled) {
    $('server').value = s.cfg.serverUrl || '';
    $('label').value = s.cfg.label || '';
    filled = true;
  }
}

$('save').addEventListener('click', async () => {
  await send('SAVE_CONFIG', { serverUrl: $('server').value, token: $('token').value, label: $('label').value });
  $('token').value = '';
  setTimeout(refresh, 600);
});
$('reconnect').addEventListener('click', async () => { await send('RECONNECT'); setTimeout(refresh, 600); });
$('open-flow').addEventListener('click', () => send('OPEN_FLOW'));
$('open-dashboard').addEventListener('click', () => {
  try {
    const url = new URL($('server').value || 'ws://127.0.0.1:8787/ws/worker');
    url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
    url.pathname = '/';
    url.search = '';
    chrome.tabs.create({ url: url.toString() });
  } catch { /* invalid url */ }
});

refresh();
setInterval(refresh, 1500);
