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

export const projectMediaZipUrl = (publicId: string, resolution?: string): string => {
  const base = `/api/projects/${encodeURIComponent(publicId)}/media.zip`;
  const url = resolution ? `${base}?resolution=${encodeURIComponent(resolution)}` : base;
  return withKey(url);
};

export async function api<T = any>(
  path: string,
  { method = 'GET', body, form, keepalive = false }: { method?: string; body?: any; form?: FormData; keepalive?: boolean } = {}
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

  const resp = await fetch(path, { method, headers, body: payload, keepalive });
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
const mediaCache = new Map<string, Promise<MediaItem[]>>();

export function invalidateMedia(): void {
  mediaCache.clear();
}

export async function allMedia(workspaceId?: string | null): Promise<MediaItem[]> {
  const key = workspaceId == null ? 'all' : String(workspaceId);
  let cached = mediaCache.get(key);
  if (!cached) {
    const query = workspaceId == null ? '' : `&workspace_id=${workspaceId}`;
    cached = api<MediaItem[]>(`/api/media?limit=1000${query}`).catch(() => []);
    mediaCache.set(key, cached);
  }
  return cached;
}

export function getMediaItem(mediaId: string): Promise<MediaItem> {
  return api<MediaItem>(`/api/media/${encodeURIComponent(mediaId)}`);
}

