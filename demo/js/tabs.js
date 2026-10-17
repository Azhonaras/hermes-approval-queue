export function initTabs({ onHistoryShown }) {
  const panes = { tabQueue: 'queuePane', tabHistory: 'historyPane' };
  function show(tabId) {
    Object.entries(panes).forEach(([tab, pane]) => {
      const active = tab === tabId;
      document.getElementById(pane).hidden = !active;
      const el = document.getElementById(tab);
      el.classList.toggle('is-active', active);
      el.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    if (tabId === 'tabHistory') onHistoryShown();
  }
  Object.keys(panes).forEach((tab) => document.getElementById(tab).addEventListener('click', () => show(tab)));
}
