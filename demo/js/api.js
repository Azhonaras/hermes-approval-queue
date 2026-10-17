/**
 * Talks to the CMS through the shared client; falls back to sample rows when no API is reachable.
 *
 * A CMS that mounts this page tells it where the API is and how the reviewer signs in, before main.js runs:
 *   window.HermesQueue = { apiBase: 'https://site/wp-json/hermes-approval/v1', headers: { 'X-WP-Nonce': '…' }, cmsHome: '/wp-admin/' };
 * (in the page itself, or in the parent page when this one runs in a same-origin iframe).
 * Without that, the demo CMS is assumed: the page at /demo/ and the API at /api/seo with the demo session.
 */
import { FALLBACK } from './fallback-data.js';

export function hostConfig() {
  if (window.HermesQueue) return window.HermesQueue;
  try {
    if (window.parent !== window && window.parent.HermesQueue) return window.parent.HermesQueue;
  } catch (e) { /* a cross-origin parent: not our host */ }
  return null;
}

export function apiBase(host = hostConfig()) {
  if (host && host.apiBase) return String(host.apiBase).replace(/\/$/, '');
  if (/^https?:$/.test(location.protocol) && /\/demo\/(index\.html)?$/.test(location.pathname)) return location.origin + '/api/seo';
  return '';
}

export async function connect() {
  const host = hostConfig();
  const base = apiBase(host);
  if (!base || !window.CmsApproval) return { live: false, review: null, host };
  const review = window.CmsApproval.createReviewClient(host && host.headers
    ? { baseUrl: base, headers: host.headers }
    : { baseUrl: base, session: 'demo-manager' });
  try {
    const ping = await fetch(base + '/ping').then((r) => r.json());
    if (!(ping && ping.success)) return { live: false, review, host };
    // The manifest may list the fields each action can write; cards warn about the others. Optional.
    const manifest = await review.manifest().catch(() => null);
    return { live: true, review, host, fields: (manifest && manifest.fields) || null };
  } catch (e) {
    return { live: false, review, host };
  }
}

export function loadAll({ live, review, host }) {
  // A CMS page that failed to reach its own API must not show the sample rows as if they were real.
  if (host && host.apiBase && !live) return Promise.reject(new Error('اتصال به API برقرار نشد.'));
  if (!live || !review) return Promise.resolve([FALLBACK.pending, FALLBACK.history]);
  return Promise.all([review.listPending(), review.listHistory()]);
}

/** What the resource holds now, so the reviewer sees before and after. Null when it cannot be read. */
export function currentValue({ live, review }, row) {
  if (!live || !review || !review.readResource) return Promise.resolve(null);
  if (/^create:/.test(row.action || '')) return Promise.resolve({}); // nothing exists yet: every field is new
  return review.readResource(row.resourceType, row.resourceId, row.siteId).catch(() => null);
}

/** Applies one decision to many ids. `edits[id]` replaces the agent's payload on approve. */
export function decideMany({ review }, verb, ids, reason, edits = {}) {
  const jobs = ids.map((id) => {
    if (verb === 'approve') return review.approve(id, reason, edits[id]);
    if (verb === 'reject') return review.reject(id, reason);
    return review.requestChanges(id, reason);
  });
  return Promise.allSettled(jobs).then((results) =>
    results.reduce((failed, r, i) => (r.status === 'rejected' ? failed.concat('HRM-' + ids[i]) : failed), []));
}
