import { MediaItem } from './types';

let apiKey = '';
try {
  apiKey = localStorage.getItem('flowhub.apiKey') || '';
} catch {
  /* ignore */
}

let onAuthRequiredCallback: (() => void) | null = null;

export function setOnAuthRequired(cb: () => void) {
  onAuthRequiredCallback = cb;
}

export function getApiKey(): string {
  return apiKey;
}

export function setApiKey(key: string): void {
  apiKey = key.trim();
  try {
    localStorage.setItem('flowhub.apiKey', apiKey);
  } catch {
    /* ignore */
  }
}

export function withKey(url: string): string {
  return apiKey ? `${url}${url.includes('?') ? '&' : '?'}key=${encodeURIComponent(apiKey)}` : url;
}

export const mediaFile = (id: string): string => withKey(`/api/media/${encodeURIComponent(id)}/file`);

export async function api<T = any>(
  path: string,
  { method = 'GET', body, form }: { method?: string; body?: any; form?: FormData } = {}
): Promise<T> {
  const headers: Record<string, string> = {};
  if (apiKey) headers['X-API-Key'] = apiKey;

  let payload: any;
  if (form) {
    payload = form;
  } else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }

  const resp = await fetch(path, { method, headers, body: payload });
  if (resp.status === 401) {
    if (onAuthRequiredCallback) onAuthRequiredCallback();
    throw new Error('Cần API key');
  }

  const isJson = (resp.headers.get('content-type') || '').includes('json');
  const data = isJson ? await resp.json() : await resp.text();

  if (!resp.ok) {
    const detail = data && data.detail;
    throw new Error(
      typeof detail === 'string' ? detail : detail ? JSON.stringify(detail) : `HTTP ${resp.status}`
    );
  }
  return data as T;
}

// Media cache
let mediaCache: Promise<MediaItem[]> | null = null;

export function invalidateMedia(): void {
  mediaCache = null;
}

export async function allMedia(): Promise<MediaItem[]> {
  if (!mediaCache) {
    mediaCache = api<MediaItem[]>('/api/media?limit=1000').catch(() => []);
  }
  return mediaCache;
}

