export function ago(ts?: number | null): string {
  if (!ts) return '';
  const s = Math.max(0, Math.round(Date.now() / 1000 - ts));
  if (s < 10) return 'vừa xong';
  if (s < 60) return `${s} giây trước`;
  if (s < 3600) return `${Math.floor(s / 60)} phút trước`;
  if (s < 86400) return `${Math.floor(s / 3600)} giờ trước`;
  return new Date(ts * 1000).toLocaleString('vi-VN');
}

export function clock(ts: number): string {
  const d = new Date(ts * 1000);
  const time = d.toLocaleTimeString('vi-VN', { hour12: false }) + '.' + String(d.getMilliseconds()).padStart(3, '0');
  return d.toDateString() === new Date().toDateString() ? time : `${d.toLocaleDateString('vi-VN')} ${time}`;
}

export const STATUS_LABEL: Record<string, string> = {
  queued: 'chờ',
  running: 'đang gửi',
  polling: 'đang render',
  done: 'xong',
  partial: 'xong một phần',
  failed: 'lỗi',
  timeout: 'hết giờ',
  canceled: 'đã huỷ',
};

export const TYPE_LABEL: Record<string, string> = {
  image: 'Ảnh',
  character: 'Nhân vật',
  edit: 'Sửa ảnh',
  t2v: 'Text → Video',
  i2v: 'Ảnh → Video',
  first_last: 'Đầu + cuối',
  r2v: 'Ingredients',
  upload: 'Upload',
  upscale: 'Upscale',
  template: 'Template',
};

export function typeLabel(t: string): string {
  return TYPE_LABEL[t] || t;
}

/** Display-only: long strings with no spaces (captcha tokens) are shortened. */
function displayJson(v: any): string {
  if (typeof v === 'string' && v.length > 160 && !/\s/.test(v)) {
    return `${JSON.stringify(v.slice(0, 40)).slice(0, -1)}…(${v.length} ký tự)"`;
  }
  return JSON.stringify(v);
}

/** Readable JSON for Flow's positional arrays (copy buttons always use the raw value). */
export function fmt(value: any, indent = ''): string {
  if (!Array.isArray(value)) {
    if (value && typeof value === 'object') return JSON.stringify(value, null, 2).replace(/\n/g, `\n${indent}`);
    return displayJson(value);
  }
  const inner = indent + '  ';
  const parts: string[] = value.map((v) => (Array.isArray(v) ? fmt(v, inner) : displayJson(v)));
  const flat = `[${parts.join(',')}]`;
  if (!flat.includes('\n') && (flat.length <= 110 || !value.some(Array.isArray))) return flat;
  const lines: string[] = [];
  let run: string[] = [];
  const flush = () => {
    if (run.length) lines.push(inner + run.join(','));
    run = [];
  };
  value.forEach((v, i) => {
    if (Array.isArray(v)) {
      flush();
      lines.push(inner + parts[i]);
    } else {
      run.push(parts[i]);
    }
  });
  flush();
  return `[\n${lines.join(',\n')}\n${indent}]`;
}

/** Inner payload of an f.req string, or null. */
export function innerOf(freq?: string): any {
  if (!freq) return null;
  try {
    return JSON.parse(JSON.parse(freq)[0][0][1]);
  } catch {
    return null;
  }
}

export function getVideoCreditCost(key?: string, duration?: number, resolution?: string): string | number {
  if (!key || key === '?') return 'không xác định';
  key = key.toLowerCase();
  if (key.includes('omni_flash') || key.includes('abra')) {
    const d = duration || parseInt(key.match(/_(\d+)s/)?.[1] || '0') || 0;
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

