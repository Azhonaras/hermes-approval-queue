/** Pending tab: renders cards, owns selection state and the risk filter. */
import { queue, diffTable } from './templates.js';
import { riskOf } from './format.js';

/** `loadCurrent(row)` resolves to what the CMS holds now (or null); it runs when a card's details are opened. */
export function createQueueView({ loadCurrent = () => Promise.resolve(null) } = {}) {
  const $ = (id) => document.getElementById(id);
  const list = $('requestList');
  const selectAll = $('selectAll');
  const filter = $('riskFilter');
  const buttons = [$('approveSelected'), $('rejectSelected'), $('requestChanges')];
  const actionsBar = document.querySelector('.hq-actions');
  const clearButton = $('clearSelection');
  let rows = [];

  const cards = () => Array.from(list.querySelectorAll('.hq-card'));
  const visibleBoxes = () => cards()
    .filter((c) => !c.classList.contains('hq-card--filtered'))
    .map((c) => c.querySelector('input.hq-select')).filter(Boolean);
  const selectedIds = () => visibleBoxes().filter((b) => b.checked).map((b) => b.value);

  function updateSelection() {
    const boxes = visibleBoxes();
    const count = boxes.filter((b) => b.checked).length;
    $('selectionLabel').textContent = count ? count.toLocaleString('fa-IR') + ' درخواست انتخاب شده' : 'هیچ موردی انتخاب نشده';
    $('selectionCount').textContent = count.toLocaleString('fa-IR');
    actionsBar.classList.toggle('has-selection', count > 0);
    clearButton.hidden = count === 0;
    buttons.forEach((b) => { b.disabled = count === 0; });
    selectAll.setAttribute('aria-pressed', boxes.length > 0 && count === boxes.length ? 'true' : 'false');
    selectAll.classList.toggle('is-partial', count > 0 && count < boxes.length);
  }

  function applyFilter() {
    cards().forEach((card) => {
      card.classList.toggle('hq-card--filtered', filter.value !== 'all' && card.dataset.risk !== filter.value);
    });
    updateSelection();
  }

  function render(nextRows, { keepSelection = false, fields = null } = {}) {
    const keep = keepSelection ? selectedIds() : [];
    rows = nextRows;
    list.innerHTML = queue(rows, fields);
    const review = rows.filter((r) => riskOf(r.action) === 'review').length;
    $('pendingCount').textContent = String(rows.length);
    $('routineCount').textContent = String(rows.length - review);
    $('reviewCount').textContent = String(review);
    $('syncedAt').textContent = new Date().toLocaleTimeString('fa-IR');
    applyFilter();
    visibleBoxes().forEach((b) => { b.checked = keep.includes(b.value); });
    updateSelection();
  }

  list.addEventListener('change', (e) => { if (e.target.classList.contains('hq-select')) updateSelection(); });
  // 'toggle' does not bubble: listen in the capture phase. Fetch the current value once per opened card.
  list.addEventListener('toggle', (e) => {
    const details = e.target;
    if (!details.open || !details.classList || !details.classList.contains('hq-details')) return;
    const box = details.querySelector('.hq-current');
    const row = rows.find((r) => String(r.approvalId) === details.dataset.id);
    if (!box || !row || box.dataset.loaded) return;
    box.dataset.loaded = '1';
    box.textContent = '…';
    loadCurrent(row).then((current) => { box.innerHTML = diffTable(current, row); });
  }, true);
  clearButton.addEventListener('click', () => { visibleBoxes().forEach((b) => { b.checked = false; }); updateSelection(); });
  selectAll.addEventListener('click', (event) => {
    event.preventDefault();
    const boxes = visibleBoxes();
    const next = !boxes.every((b) => b.checked);
    boxes.forEach((b) => { b.checked = next; });
    updateSelection();
  });
  filter.addEventListener('change', applyFilter);
  $('collapseAll').addEventListener('click', (event) => {
    const details = Array.from(list.querySelectorAll('details'));
    const open = details.every((d) => !d.open);
    details.forEach((d) => { d.open = open; });
    event.currentTarget.textContent = open ? 'بستن جزئیات' : 'نمایش همه جزئیات';
  });

  return {
    render,
    selectedIds,
    selectedRows: () => rows.filter((r) => selectedIds().includes(String(r.approvalId)))
  };
}
