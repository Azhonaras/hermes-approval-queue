/** "Back to CMS" link: data attribute, global, query string, then same-origin referrer. */
function queryParam(name) {
  const match = location.search.match(new RegExp('[?&]' + name + '=([^&]*)'));
  return match ? decodeURIComponent(match[1].replace(/\+/g, ' ')) : '';
}

function cmsHomeUrl() {
  const root = document.querySelector('.hermes-queue');
  const fromAttr = root && String(root.getAttribute('data-cms-home') || '').trim();
  if (fromAttr) return fromAttr;
  if (window.HermesQueue && window.HermesQueue.cmsHome) return window.HermesQueue.cmsHome;
  const fromQuery = queryParam('cmsHome') || queryParam('return');
  if (fromQuery) return fromQuery;
  if (document.referrer) {
    try {
      const ref = new URL(document.referrer);
      if (ref.origin === location.origin && ref.pathname !== location.pathname) return document.referrer;
    } catch (e) { /* ignore a malformed referrer */ }
  }
  return '';
}

export function initCmsHome() {
  const link = document.getElementById('cmsHomeLink');
  if (!link) return;
  const home = cmsHomeUrl();
  // In a CMS frame (wp-admin) the CMS must open in the whole window, not inside the frame.
  if (window.parent !== window) link.target = '_top';
  if (home) link.href = home;
  else link.addEventListener('click', (event) => { if (history.length > 1) { event.preventDefault(); history.back(); } });
}
