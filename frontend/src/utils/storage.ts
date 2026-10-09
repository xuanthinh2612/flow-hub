export function loadPref<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(`flowhub.${key}`);
    if (raw === null) return fallback;
    const parsed = JSON.parse(raw);
    const isObj = (v: any) => v && typeof v === 'object' && !Array.isArray(v);
    return isObj(fallback) && isObj(parsed) ? { ...fallback, ...parsed } : parsed;
  } catch {
    return fallback;
  }
}

export function savePref<T>(key: string, value: T): void {
  try {
    localStorage.setItem(`flowhub.${key}`, JSON.stringify(value));
  } catch {
    /* private mode */
  }
}

export interface ImageFormState {
  mode: 'gen' | 'edit';
  prompt: string;
  family: string | null;
  customModel: string;
  useCustom: boolean;
  aspect: string;
  count: number;
  seed: string;
  perVariant: string;
  refs: string[];
  base: string | null;
  characterId: string;
}

export interface CharacterFormState {
  gender: string | null;
  country: string | null;
  vibe: string;
  extras: string;
  prompt: string;
  promptEdited: boolean;
  family: string | null;
  customModel: string;
  useCustom: boolean;
  aspect: string;
  count: number;
}

export interface VideoFormState {
  mode: 't2v' | 'i2v' | 'first_last' | 'r2v';
  prompt: string;
  families: Record<string, string | null>;
  customModel: string;
  useCustom: boolean;
  aspect: string;
  count: number;
  duration: number;
  resolution: string;
  starts: string[];
  start: string | null;
  end: string | null;
  refs: string[];
  timeoutMin: number;
}

export const DEFAULTS: {
  image: ImageFormState;
  character: CharacterFormState;
  video: VideoFormState;
} = {
  image: {
    mode: 'gen',
    prompt: '',
    family: null,
    customModel: '',
    useCustom: false,
    aspect: '16:9',
    count: 1,
    seed: '',
    perVariant: '',
    refs: [],
    base: null,
    characterId: '',
  },
  character: {
    gender: null,
    country: null,
    vibe: 'clean',
    extras: '',
    prompt: '',
    promptEdited: false,
    family: null,
    customModel: '',
    useCustom: false,
    aspect: '1:1',
    count: 1,
  },
  video: {
    mode: 't2v',
    prompt: '',
    families: {},
    customModel: '',
    useCustom: false,
    aspect: '16:9',
    count: 1,
    duration: 8,
    resolution: '720p',
    starts: [],
    start: null,
    end: null,
    refs: [],
    timeoutMin: 10,
  },
};

export function loadForm<K extends keyof typeof DEFAULTS>(page: K): (typeof DEFAULTS)[K] {
  return loadPref(`form.${page}`, structuredClone(DEFAULTS[page]));
}

export function saveForm<K extends keyof typeof DEFAULTS>(page: K, state: (typeof DEFAULTS)[K]): void {
  savePref(`form.${page}`, state);
}

const pageOfType: Record<string, 'image' | 'character' | 'video'> = {
  image: 'image',
  edit: 'image',
  character: 'character',
  t2v: 'video',
  i2v: 'video',
  first_last: 'video',
  r2v: 'video',
};

/** Put a past job's spec back into its form ("Dùng lại"). Returns the page name. */
export function reuseSpec(spec: any): 'image' | 'character' | 'video' | null {
  const page = pageOfType[spec.type];
  if (!page) return null;
  const form: any = { ...structuredClone(DEFAULTS[page]), ...loadForm(page) };
  const model = spec.model;
  if (page === 'image') {
    Object.assign(form, {
      mode: spec.type === 'edit' ? 'edit' : 'gen',
      prompt: spec.prompt || '',
      aspect: spec.aspect || '16:9',
      count: spec.count || 1,
      seed: spec.seed ?? '',
      perVariant: (spec.prompts || []).join('\n'),
      refs: spec.ref_media_ids || [],
      base: spec.base_media_id || null,
      family: spec.family || null,
      characterId: spec.character_id || '',
      useCustom: !spec.family,
      customModel: spec.family ? '' : model || '',
    });
  } else if (page === 'character') {
    const c = spec.character || {};
    Object.assign(form, {
      gender: c.gender ?? null,
      country: c.country ?? null,
      vibe: c.vibe || 'clean',
      extras: c.extras || '',
      prompt: spec.prompt || '',
      promptEdited: true,
      aspect: spec.aspect || '1:1',
      count: spec.count || 1,
      family: spec.family || null,
      useCustom: !spec.family,
      customModel: spec.family ? '' : model || '',
    });
  } else {
    Object.assign(form, {
      mode: spec.type,
      prompt: spec.prompt || '',
      aspect: spec.aspect || '16:9',
      count: spec.count || 1,
      duration: spec.duration || form.duration,
      resolution: spec.resolution || form.resolution,
      starts: spec.start_media_ids || [],
      start: spec.start_media_id || null,
      end: spec.end_media_id || null,
      refs: spec.ref_media_ids || [],
      timeoutMin: spec.timeout_s ? Math.round(spec.timeout_s / 60) : form.timeoutMin,
      useCustom: !spec.family,
      customModel: spec.family ? '' : model || '',
    });
    form.families = { ...(form.families || {}), [spec.type]: spec.family || null };
  }
  saveForm(page, form);
  return page;
}

/** Add a media id to a field of a form ("Dùng cho"). */
export function useMediaIn(
  page: 'image' | 'character' | 'video',
  fieldName: string,
  mediaId: string,
  { multi = true, patch = {} }: { multi?: boolean; patch?: any } = {}
): void {
  const form: any = { ...structuredClone(DEFAULTS[page]), ...loadForm(page), ...patch };
  if (multi) form[fieldName] = [...new Set([...(form[fieldName] || []), mediaId])];
  else form[fieldName] = mediaId;
  saveForm(page, form);
}

