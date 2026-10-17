/**
 * Auto-refresh every minute, paused while the tab is hidden or a dialog is open. (It was 10 minutes, but an agent
 * waits for the decision: a request should show up while the reviewer is looking at the page.)
 */
const REFRESH_MS = 60 * 1000;
const RETRY_MS = 15000;

export function digitsFa(n, width) {
  return String(n).padStart(width, '0').replace(/\d/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[Number(d)]);
}

export function createRefresher({ reload, isBlocked }) {
  let timer = null;
  let deadline = 0;

  function paint() {
    const el = document.getElementById('refreshIn');
    if (!el) return;
    const total = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
    el.textContent = digitsFa(Math.floor(total / 60), 2) + ':' + digitsFa(total % 60, 2);
  }
  function schedule() {
    clearTimeout(timer);
    deadline = Date.now() + REFRESH_MS;
    paint();
    timer = setTimeout(tick, REFRESH_MS);
  }
  function tick() {
    if (document.hidden || isBlocked()) { timer = setTimeout(tick, RETRY_MS); return; }
    reload().then(schedule, schedule);
  }
  setInterval(paint, 1000);
  schedule();
  return { schedule };
}
