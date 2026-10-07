// Router, live events and sidebar badges.
import { $, $$, api, connectEvents, debounce, invalidateMedia, closeModal, fill } from './core.js';
import overview from './pages/overview.js';
import { imagePage, characterPage, videoPage } from './pages/create.js';
import library from './pages/library.js';
import jobs from './pages/jobs.js';
import observe from './pages/observe.js';
import models from './pages/models.js';
import templates from './pages/templates.js';
import settings from './pages/settings.js';

const PAGES = { overview, image: imagePage, character: characterPage, video: videoPage, library, jobs, observe,
  models, templates, settings };

let current = null;
let cleanup = null;

function route() {
  const name = location.hash.replace(/^#\/?/, '').split('?')[0] || 'overview';
  const page = PAGES[name] || overview;
  for (const a of $$('#nav a[data-route]')) a.classList.toggle('active', a.dataset.route === name);
  if (typeof cleanup === 'function') cleanup();
  closeModal();
  const root = $('#view');
  fill(root);
  current = page;
  document.title = `${page.title || 'Flow Hub'} · Flow Hub`;
  cleanup = page.render(root) || null;
}

const refreshBadges = debounce(async () => {
  try {
    const o = await api('/api/overview');
    const online = o.workers.filter((w) => w.online);
    const pill = $('#worker-pill');
    pill.className = `pill ${online.length ? 'ok' : 'err'}`;
    pill.textContent = online.length ? `● ${online.length} worker` : '○ chưa có worker';
    $('#alerts-badge').textContent = o.alerts_unseen || '';
    const active = (o.job_counts.queued || 0) + (o.job_counts.running || 0) + (o.job_counts.polling || 0);
    $('#jobs-badge').textContent = active || '';
  } catch { /* auth prompt or server down */ }
}, 400);

connectEvents((evt) => {
  if (evt.type === 'media') invalidateMedia();
  if (evt.type === 'worker' || evt.type === 'alert' || evt.type === 'job') refreshBadges();
  if (current && current.onEvent) current.onEvent(evt);
});

$('#modal-close').addEventListener('click', closeModal);
window.addEventListener('hashchange', route);
route();
refreshBadges();
setInterval(refreshBadges, 15000);
