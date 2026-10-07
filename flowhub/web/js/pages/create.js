// The three create pages: image (+ edit), character, video (t2v / i2v / first+last / ingredients).
import { h, api, toast, chipGroup, field, mediaPicker, fmt, debounce, fill } from '../core.js';
import { loadForm, saveForm } from '../forms.js';
import { jobTable } from './jobs.js';

const IMAGE_ASPECTS = ['1:1', '9:16', '16:9', '3:4', '4:3'].map((a) => ({ value: a, label: a }));
const VIDEO_ASPECTS = [{ value: '16:9', label: '16:9' }, { value: '9:16', label: '9:16' }];
const COUNTS = [1, 2, 3, 4].map((n) => ({ value: n, label: String(n) }));
const lines = (text) => (text || '').split('\n').map((s) => s.trim()).filter(Boolean);

/** Family select backed by the catalog, plus a free wire-id escape hatch. */
function modelPicker(mode, form, getFamily, setFamily, save, onChange) {
  const select = h('select', { class: 'input' });
  const custom = h('input', { class: 'input mono', placeholder: 'wire id, VD: veo_3_1_t2v_fast', spellcheck: 'false',
    value: form.customModel || '', style: { marginTop: '6px' } });
  let families = [];
  const state = {
    el: h('div', null, select, custom),
    family: () => (select.value === '__custom' ? null : select.value),
    variants: () => (families.find((f) => f.family === select.value) || {}).variants || [],
  };
  const load = async () => {
    try {
      families = (await api(`/api/models?mode=${mode}`)).families
        .filter((f) => f.variants.some((v) => v.status !== 'disabled'));
    } catch { families = []; }
    fill(select, ...families.map((f) => {
      const verified = f.variants.some((v) => v.status === 'verified');
      return h('option', { value: f.family }, `${f.label}${f.default ? ' (mặc định)' : ''}${verified ? '' : ' · chưa xác minh'}`);
    }), h('option', { value: '__custom' }, 'Wire id khác…'));
    const wanted = getFamily();
    select.value = form.useCustom ? '__custom'
      : (families.some((f) => f.family === wanted) ? wanted : (families.find((f) => f.default) || families[0] || {}).family || '__custom');
    custom.hidden = select.value !== '__custom';
    onChange();
  };
  select.addEventListener('change', () => {
    form.useCustom = select.value === '__custom';
    if (!form.useCustom) setFamily(select.value);
    custom.hidden = !form.useCustom;
    save();
    onChange();
  });
  custom.addEventListener('input', () => { form.customModel = custom.value; save(); onChange(); });
  load();
  return state;
}

async function resolveLine(line, mode, picker, form, extra = {}) {
  if (form.useCustom) {
    line.className = 'model-line';
    line.textContent = `→ ${form.customModel || '?'} (wire id tự nhập)`;
    return;
  }
  const q = new URLSearchParams({ mode, ...(picker.family() ? { family: picker.family() } : {}) });
  for (const [k, v] of Object.entries(extra)) if (v !== null && v !== undefined && v !== '') q.set(k, v);
  try {
    const r = await api(`/api/models/resolve?${q}`);
    line.className = `model-line${r.status === 'verified' ? '' : ' warn'}`;
    line.textContent = `→ ${r.key} · ${r.status === 'verified' ? 'đã xác minh' : 'CHƯA xác minh trên Flow hiện tại'}${r.note ? ` · ${r.note}` : ''}`;
  } catch (e) {
    line.className = 'model-line err';
    line.textContent = e.message;
  }
}

function modelSpec(form, picker) {
  return form.useCustom ? { model: (form.customModel || '').trim() } : { family: picker.family() };
}

function recentPanel(types) {
  const list = h('div', null, h('p', { class: 'empty' }, 'Đang tải…'));
  const load = async () => {
    try {
      const jobs = (await Promise.all(types.map((t) => api(`/api/jobs?type=${t}&limit=8`)))).flat()
        .sort((a, b) => b.created_at - a.created_at).slice(0, 8);
      fill(list, jobTable(jobs));
    } catch (e) { fill(list, h('p', { class: 'err' }, e.message)); }
  };
  return { el: h('div', { class: 'card' }, h('h2', null, 'Kết quả gần đây'), list), load };
}

function actionsRow(label, getSpec) {
  const out = h('pre', { class: 'body', hidden: true });
  const btn = h('button', { class: 'btn btn-primary', onclick: async () => {
    btn.disabled = true;
    try {
      const job = await api('/api/jobs', { method: 'POST', body: getSpec() });
      toast(`Đã gửi job ${job.id} — theo dõi ở cột bên phải`, 'ok');
    } catch (e) { toast(e.message, 'err'); }
    setTimeout(() => { btn.disabled = false; }, 700);
  } }, label);
  const preview = h('button', { class: 'btn', onclick: async () => {
    if (!out.hidden) { out.hidden = true; return; }
    try {
      const calls = await api('/api/jobs/preview', { method: 'POST', body: getSpec() });
      out.textContent = calls.map((c, i) => `── request ${i + 1}/${calls.length} · ${c.label} · ${c.rpcid} · captcha ${c.captcha_action || '—'} · model ${c.model || '—'}${c.model_status ? ` (${c.model_status})` : ''} ──\n`
        + 'POST https://flow.google.com/_/AiSandboxAngularFrontend/data/batchexecute?rpcids=' + c.rpcid + '&…\n'
        + `f.req = [[["${c.rpcid}", JSON.stringify(inner), null, "generic"]]]   ·   "__CAPTCHA__" được thay bằng token mới\ninner =\n${fmt(c.inner)}`).join('\n\n');
    } catch (e) { out.textContent = `⚠ ${e.message}`; }
    out.hidden = false;
  } }, 'Xem body');
  return [h('div', { class: 'actions' }, btn, preview), out];
}

function pageHead(title, desc) {
  return h('div', { class: 'page-head' }, h('div', null, h('h1', null, title), h('p', null, desc)));
}

// ── Ảnh ─────────────────────────────────────────────────────────────────────

export const imagePage = {
  title: 'Tạo ảnh',
  render(root) {
    const form = loadForm('image');
    const save = () => saveForm('image', form);
    const line = h('div', { class: 'model-line' });
    let picker;
    const refresh = debounce(() => resolveLine(line, 'image', picker, form), 150);
    picker = modelPicker('image', form, () => form.family, (v) => { form.family = v; }, save, refresh);
    const baseField = field(h('span', null, 'Ảnh gốc cần sửa ', h('span', { class: 'tag' }, 'BASE_IMAGE · type 2')),
      mediaPicker({ value: form.base, onChange: (v) => { form.base = v; save(); } }));
    const countField = field('Số ảnh (mỗi ảnh = 1 request + 1 captcha)', chipGroup(COUNTS, form.count, (v) => { form.count = v; save(); }));
    const variantField = field('Prompt riêng từng biến thể (mỗi dòng 1 prompt)',
      h('textarea', { class: 'input', rows: 3, value: form.perVariant, oninput: (e) => { form.perVariant = e.target.value; save(); } }));
    const sync = () => { baseField.hidden = form.mode !== 'edit'; countField.hidden = form.mode === 'edit'; variantField.hidden = form.mode === 'edit'; };
    const spec = () => ({ type: form.mode === 'edit' ? 'edit' : 'image', prompt: form.prompt, ...modelSpec(form, picker),
      aspect: form.aspect, count: form.count, seed: form.seed === '' || form.seed === null ? null : Number(form.seed),
      prompts: form.mode === 'edit' ? null : (lines(form.perVariant).length ? lines(form.perVariant) : null),
      ref_media_ids: form.refs, base_media_id: form.mode === 'edit' ? form.base : null });
    const recent = recentPanel(['image', 'edit']);
    root.append(pageHead('Tạo ảnh', 'ogiZ0b — tạo mới hoặc sửa ảnh, có ảnh tham chiếu. Mỗi biến thể là một request riêng như giao diện Flow.'),
      h('div', { class: 'cols' }, h('div', { class: 'card' },
        chipGroup([{ value: 'gen', label: 'Tạo ảnh' }, { value: 'edit', label: 'Chỉnh sửa ảnh' }], form.mode,
          (v) => { form.mode = v; save(); sync(); }, { cls: 'seg' }),
        baseField,
        field('Prompt', h('textarea', { class: 'input', rows: 4, value: form.prompt, placeholder: 'Mô tả bức ảnh…',
          oninput: (e) => { form.prompt = e.target.value; save(); } })),
        field(h('span', null, 'Ảnh tham chiếu ', h('span', { class: 'tag' }, 'REFERENCE · type 1'), h('span', { class: 'muted' }, ' (tuỳ chọn)')),
          mediaPicker({ value: form.refs, multi: true, onChange: (v) => { form.refs = v; save(); } })),
        field('Model', picker.el, line),
        field('Tỉ lệ', chipGroup(IMAGE_ASPECTS, form.aspect, (v) => { form.aspect = v; save(); })),
        countField,
        h('details', { class: 'adv' }, h('summary', null, 'Nâng cao'),
          field('Seed (trống = ngẫu nhiên; mỗi biến thể +9973)', h('input', { class: 'input mono', type: 'number', value: form.seed,
            oninput: (e) => { form.seed = e.target.value; save(); } })),
          variantField),
        ...actionsRow('Tạo ảnh', spec)), recent.el));
    sync();
    recent.load();
    this._recent = debounce(recent.load, 500);
  },
  onEvent(evt) { if (evt.type === 'job') this._recent?.(); },
};

// ── Nhân vật ────────────────────────────────────────────────────────────────

export const characterPage = {
  title: 'Nhân vật',
  render(root) {
    const form = loadForm('character');
    const save = () => saveForm('character', form);
    const line = h('div', { class: 'model-line' });
    let picker;
    const refreshLine = debounce(() => resolveLine(line, 'image', picker, form), 150);
    picker = modelPicker('image', form, () => form.family, (v) => { form.family = v; }, save, refreshLine);
    const promptBox = h('textarea', { class: 'input', rows: 7, value: form.prompt,
      oninput: (e) => { form.prompt = e.target.value; form.promptEdited = true; save(); } });
    const rebuild = debounce(async () => {
      if (form.promptEdited) return;
      try {
        const r = await api('/api/presets/character/prompt', { method: 'POST',
          body: { gender: form.gender, country: form.country, vibe: form.vibe, extras: form.extras } });
        form.prompt = r.prompt;
        promptBox.value = r.prompt;
        save();
      } catch { /* ignore */ }
    }, 200);
    const choices = h('div', null, h('p', { class: 'empty' }, 'Đang tải preset…'));
    api('/api/presets/character').then((p) => {
      const opts = (list) => list.map((x) => ({ value: x.key, label: x.label }));
      fill(choices, 
        field('Giới tính', chipGroup(opts(p.genders), form.gender, (v) => { form.gender = v; save(); rebuild(); }, { toggle: true })),
        field('Quốc gia', chipGroup(opts(p.countries), form.country, (v) => { form.country = v; save(); rebuild(); }, { toggle: true })),
        field('Phong cách', chipGroup(opts(p.vibes), form.vibe, (v) => { form.vibe = v; save(); rebuild(); })));
    });
    const spec = () => ({ type: 'character', prompt: form.prompt, ...modelSpec(form, picker), aspect: form.aspect,
      count: form.count, character: { gender: form.gender, country: form.country, vibe: form.vibe, extras: form.extras } });
    const recent = recentPanel(['character']);
    root.append(pageHead('Nhân vật', 'Chân dung chính diện dùng làm tham chiếu cho các cảnh sau (vẫn là ogiZ0b). Ảnh tạo ra có nhãn "character" trong Thư viện.'),
      h('div', { class: 'cols' }, h('div', { class: 'card' }, choices,
        field('Mô tả thêm (tuỳ chọn)', h('input', { class: 'input', value: form.extras, placeholder: 'VD: tóc ngắn màu nâu, 25 tuổi',
          oninput: (e) => { form.extras = e.target.value; save(); rebuild(); } })),
        field(h('span', null, 'Prompt sẽ gửi ', h('button', { class: 'btn btn-sm btn-ghost', onclick: () => { form.promptEdited = false; rebuild(); } }, '↺ tạo lại từ lựa chọn')), promptBox),
        field('Model', picker.el, line),
        field('Tỉ lệ', chipGroup(IMAGE_ASPECTS, form.aspect, (v) => { form.aspect = v; save(); })),
        field('Số ảnh', chipGroup(COUNTS, form.count, (v) => { form.count = v; save(); })),
        ...actionsRow('Tạo nhân vật', spec)), recent.el));
    if (!form.prompt) rebuild();
    recent.load();
    this._recent = debounce(recent.load, 500);
  },
  onEvent(evt) { if (evt.type === 'job') this._recent?.(); },
};

// ── Video ───────────────────────────────────────────────────────────────────

const VIDEO_MODES = [
  { value: 't2v', label: 'Text → Video', hint: 'YhhmEf' },
  { value: 'i2v', label: 'Ảnh → Video', hint: 'eb1hJf' },
  { value: 'first_last', label: 'Ảnh đầu + cuối', hint: 'nprQif' },
  { value: 'r2v', label: 'Ingredients', hint: 'MZZa6b' },
];

export const videoPage = {
  title: 'Tạo video',
  render(root) {
    const form = loadForm('video');
    form.families = form.families || {};
    const save = () => saveForm('video', form);
    const body = h('div');
    const recent = recentPanel(['t2v', 'i2v', 'first_last', 'r2v']);

    const build = () => {
      const mode = form.mode;
      const line = h('div', { class: 'model-line' });
      const attrs = h('div');
      let picker;
      const refreshLine = debounce(() => {
        const v = picker.variants();
        const hasDur = v.some((x) => x.duration);
        const hasRes = v.some((x) => x.resolution);
        resolveLine(line, mode, picker, form, { aspect: form.aspect, duration: hasDur ? form.duration : null,
          resolution: hasRes ? form.resolution : null });
      }, 150);
      const renderAttrs = () => {
        const v = picker.variants();
        const durations = [...new Set(v.map((x) => x.duration).filter(Boolean))].sort((a, b) => a - b);
        const resolutions = [...new Set(v.map((x) => x.resolution).filter(Boolean))];
        if (durations.length && !durations.includes(form.duration)) form.duration = durations.includes(8) ? 8 : durations[0];
        if (resolutions.length && !resolutions.includes(form.resolution)) form.resolution = resolutions[0];
        fill(attrs, 
          durations.length ? field('Thời lượng', chipGroup(durations.map((d) => ({ value: d, label: `${d}s` })), form.duration,
            (x) => { form.duration = x; save(); refreshLine(); })) : null,
          resolutions.length ? field('Độ phân giải', chipGroup(resolutions.map((r) => ({ value: r, label: r })), form.resolution,
            (x) => { form.resolution = x; save(); refreshLine(); })) : null);
        refreshLine();
      };
      picker = modelPicker(mode, form, () => form.families[mode], (v) => { form.families[mode] = v; }, save, renderAttrs);

      const inputs = [];
      if (mode === 'i2v') inputs.push(field('Ảnh đầu (mỗi ảnh → 1 video)', mediaPicker({ value: form.starts, multi: true, onChange: (v) => { form.starts = v; save(); } })));
      if (mode === 'first_last') inputs.push(h('div', { class: 'grid-2' },
        field('Ảnh đầu', mediaPicker({ value: form.start, onChange: (v) => { form.start = v; save(); } })),
        field('Ảnh cuối', mediaPicker({ value: form.end, onChange: (v) => { form.end = v; save(); } }))));
      if (mode === 'r2v') inputs.push(field('Ingredients (nhân vật, đồ vật, bối cảnh…)', mediaPicker({ value: form.refs, multi: true, onChange: (v) => { form.refs = v; save(); } })));

      const spec = () => {
        const v = picker.variants();
        return { type: mode, prompt: form.prompt, ...modelSpec(form, picker), aspect: form.aspect, count: form.count,
          duration: v.some((x) => x.duration) ? form.duration : null, resolution: v.some((x) => x.resolution) ? form.resolution : null,
          start_media_ids: mode === 'i2v' ? form.starts : [], start_media_id: mode === 'first_last' ? form.start : null,
          end_media_id: mode === 'first_last' ? form.end : null, ref_media_ids: mode === 'r2v' ? form.refs : [],
          timeout_min: Number(form.timeoutMin) || 10 };
      };
      fill(body, 
        chipGroup(VIDEO_MODES, mode, (v) => { form.mode = v; save(); build(); }, { cls: 'seg' }),
        ...inputs,
        field('Prompt', h('textarea', { class: 'input', rows: 4, value: form.prompt, placeholder: 'Mô tả chuyển động, camera, âm thanh…',
          oninput: (e) => { form.prompt = e.target.value; save(); } })),
        field('Model', picker.el, line),
        attrs,
        h('div', { class: 'grid-2' },
          field('Tỉ lệ', chipGroup(VIDEO_ASPECTS, form.aspect, (v) => { form.aspect = v; save(); refreshLine(); })),
          field(mode === 'i2v' ? 'Số video mỗi ảnh' : 'Số video', chipGroup(COUNTS, form.count, (v) => { form.count = v; save(); }))),
        h('details', { class: 'adv' }, h('summary', null, 'Nâng cao'),
          field('Thời gian chờ tối đa (phút)', h('input', { class: 'input', type: 'number', min: 1, max: 60, value: form.timeoutMin,
            oninput: (e) => { form.timeoutMin = e.target.value; save(); } }))),
        ...actionsRow('Tạo video', spec));
    };
    build();
    root.append(pageHead('Tạo video', 'Gửi lệnh, server tự poll (jwpduf → as29s như giao diện Flow) và lưu video về Thư viện.'),
      h('div', { class: 'cols' }, h('div', { class: 'card' }, body), recent.el));
    recent.load();
    this._recent = debounce(recent.load, 500);
  },
  onEvent(evt) { if (evt.type === 'job') this._recent?.(); },
};
