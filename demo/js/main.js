import { initCmsHome } from './cms-home.js';
import { createQueueView } from './queue-view.js';
import { createHistoryView } from './history-view.js';
import { initTabs } from './tabs.js';
import { initDialogs, anyDialogOpen } from './dialogs.js';
import { createRefresher } from './refresh.js';
import { connect, loadAll, decideMany, currentValue, hostConfig } from './api.js';

const $ = (id) => document.getElementById(id);
const flash = $('flash');
function showFlash(text, ok) {
  flash.hidden = false;
  flash.className = 'hq-msg ' + (ok === false ? 'hq-msg--err' : 'hq-msg--ok');
  flash.textContent = text;
}

let conn = { live: false, review: null, host: null, fields: null };
const loadCurrent = (row) => currentValue(conn, row);
const queueView = createQueueView({ loadCurrent });
const historyView = createHistoryView();

function load({ keepSelection = false } = {}) {
  return loadAll(conn).then(([pending, history]) => {
    queueView.render(pending, { keepSelection, fields: conn.fields });
    historyView.render(history);
  }).catch((err) => showFlash(err.message || 'بارگذاری ناموفق بود', false));
}

async function decide(verb, reason, edits) {
  const ids = queueView.selectedIds();
  if (!ids.length) return;
  if (!conn.live) { showFlash('برای ثبت تصمیم، دمو CMS را اجرا کنید.', false); return; }
  const failed = await decideMany(conn, verb, ids, reason, edits);
  showFlash(failed.length ? 'ثبت ناموفق برای ' + failed.join('، ') + '. موارد موفق ثبت شدند.' : 'ثبت شد.', !failed.length);
  return load();
}

// Inside a CMS page the demo banner is noise; the CMS's own chrome is around us.
const host = hostConfig();
if (host) {
  const banner = document.querySelector('.banner');
  if (banner) banner.hidden = true;
  if (host.cmsHome && !window.HermesQueue) window.HermesQueue = host; // cms-home.js reads window.HermesQueue.cmsHome
}
initCmsHome();
initTabs({ onHistoryShown: historyView.enhanceNotes });
initDialogs({ getRows: queueView.selectedRows, getIds: queueView.selectedIds, onDecide: decide, getFields: () => conn.fields, loadCurrent });
const refresher = createRefresher({ reload: () => load({ keepSelection: true }), isBlocked: anyDialogOpen });
$('refreshQueue').addEventListener('click', () => load({ keepSelection: true }).then(refresher.schedule));

connect().then((c) => {
  conn = c;
  if (c.live) $('liveHint').textContent = c.host ? 'متصل به CMS — تصمیم‌ها ذخیره می‌شوند' : 'متصل به دمو CMS — تصمیم‌ها ذخیره می‌شوند';
  return load();
});
