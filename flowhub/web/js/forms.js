// Form state for the create pages, kept per browser, and its mapping to job specs.
import { loadPref, savePref } from './core.js';

export const DEFAULTS = {
  image: { mode: 'gen', prompt: '', family: null, customModel: '', useCustom: false, aspect: '16:9', count: 1,
    seed: '', perVariant: '', refs: [], base: null, characterId: '' },
  character: { gender: null, country: null, vibe: 'clean', extras: '', prompt: '', promptEdited: false,
    family: null, customModel: '', useCustom: false, aspect: '1:1', count: 1 },
  video: { mode: 't2v', prompt: '', families: {}, customModel: '', useCustom: false, aspect: '16:9', count: 1,
    duration: 8, resolution: '720p', starts: [], start: null, end: null, refs: [], timeoutMin: 10 },
};

export const loadForm = (page) => loadPref(`form.${page}`, structuredClone(DEFAULTS[page]));
export const saveForm = (page, state) => savePref(`form.${page}`, state);

const pageOfType = { image: 'image', edit: 'image', character: 'character', t2v: 'video', i2v: 'video',
  first_last: 'video', r2v: 'video' };

/** Put a past job's spec back into its form ("Dùng lại"). Returns the page name. */
export function reuseSpec(spec) {
  const page = pageOfType[spec.type];
  if (!page) return null;
  const form = { ...structuredClone(DEFAULTS[page]), ...loadForm(page) };
  const model = spec.model;
  if (page === 'image') {
    Object.assign(form, { mode: spec.type === 'edit' ? 'edit' : 'gen', prompt: spec.prompt || '', aspect: spec.aspect || '16:9',
      count: spec.count || 1, seed: spec.seed ?? '', perVariant: (spec.prompts || []).join('\n'),
      refs: spec.ref_media_ids || [], base: spec.base_media_id || null, family: spec.family || null,
      characterId: spec.character_id || '',
      useCustom: !spec.family, customModel: spec.family ? '' : (model || '') });
  } else if (page === 'character') {
    const c = spec.character || {};
    Object.assign(form, { gender: c.gender ?? null, country: c.country ?? null, vibe: c.vibe || 'clean',
      extras: c.extras || '', prompt: spec.prompt || '', promptEdited: true, aspect: spec.aspect || '1:1',
      count: spec.count || 1, family: spec.family || null, useCustom: !spec.family, customModel: spec.family ? '' : (model || '') });
  } else {
    Object.assign(form, { mode: spec.type, prompt: spec.prompt || '', aspect: spec.aspect || '16:9',
      count: spec.count || 1, duration: spec.duration || form.duration, resolution: spec.resolution || form.resolution,
      starts: spec.start_media_ids || [], start: spec.start_media_id || null, end: spec.end_media_id || null,
      refs: spec.ref_media_ids || [], timeoutMin: spec.timeout_s ? Math.round(spec.timeout_s / 60) : form.timeoutMin,
      useCustom: !spec.family, customModel: spec.family ? '' : (model || '') });
    form.families = { ...(form.families || {}), [spec.type]: spec.family || null };
  }
  saveForm(page, form);
  return page;
}

/** Add a media id to a field of a form ("Dùng cho"). */
export function useMediaIn(page, fieldName, mediaId, { multi = true, patch = {} } = {}) {
  const form = { ...structuredClone(DEFAULTS[page]), ...loadForm(page), ...patch };
  if (multi) form[fieldName] = [...new Set([...(form[fieldName] || []), mediaId])];
  else form[fieldName] = mediaId;
  saveForm(page, form);
}
