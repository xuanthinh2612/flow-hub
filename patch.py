import sys
path = 'flowhub/web/js/pages/create.js'
with open(path, 'r', encoding='utf-8') as f:
    text = f.read()

replacement = r'''function getVideoCreditCost(key, duration, resolution) {
  if (!key || key === '?') return 'không xác định';
  key = key.toLowerCase();
  if (key.includes('omni_flash') || key.includes('abra')) {
    const d = duration || parseInt(key.match(/_(\d+)s/)?.[1]) || 0;
    const res = resolution || (key.includes('360p') ? '360p' : '720p');
    if (res === '360p') {
      if (d === 4) return 4;
      if (d === 6) return 5;
      if (d === 8) return 6;
      if (d === 10) return 7;
    } else {
      if (d === 4) return 7;
      if (d === 6) return 10;
      if (d === 8) return 12;
      if (d === 10) return 15;
    }
  }
  if (key.includes('veo_3_1_') && key.includes('_lite')) return 10;
  if (key.includes('veo_3_1_') && key.includes('_fast')) return 20;
  return 'không xác định';
}

async function resolveLine(line, mode, picker, form, extra = {}) {
  if (form.useCustom) {
    line.className = 'model-line';
    let text = `→ ${form.customModel || '?'} (wire id tự nhập)`;
    if (['t2v', 'i2v', 'first_last', 'r2v'].includes(mode)) {
      text += ` • 💳 Tín dụng: ${getVideoCreditCost(form.customModel, extra.duration, extra.resolution)}`;
    }
    line.textContent = text;
    return;
  }
  const q = new URLSearchParams({ mode, ...(picker.family() ? { family: picker.family() } : {}) });
  for (const [k, v] of Object.entries(extra)) if (v !== null && v !== undefined && v !== '') q.set(k, v);
  try {
    const r = await api(`/api/models/resolve?${q}`);
    line.className = `model-line${r.status === 'verified' ? '' : ' warn'}`;
    let text = `→ ${r.key} • ${r.status === 'verified' ? 'đã xác minh' : 'CHƯA xác minh trên Flow hiện tại'}${r.note ? ` • ${r.note}` : ''}`;
    if (['t2v', 'i2v', 'first_last', 'r2v'].includes(mode)) {
      text += ` • 💳 Tín dụng: ${getVideoCreditCost(r.key, r.duration || extra.duration, r.resolution || extra.resolution)}`;
    }
    line.textContent = text;
  } catch (e) {
    line.className = 'model-line err';
    line.textContent = e.message;
  }
}'''

start_str = 'async function resolveLine(line, mode, picker, form, extra = {}) {'
end_str = 'function modelSpec(form, picker) {'

start_idx = text.find(start_str)
end_idx = text.find(end_str)

if start_idx != -1 and end_idx != -1:
    new_text = text[:start_idx] + replacement + '\n\n' + text[end_idx:]
    with open(path, 'w', encoding='utf-8') as f:
        f.write(new_text)
    print('Patched resolveLine in create.js')
else:
    print('Failed to find start or end index')
