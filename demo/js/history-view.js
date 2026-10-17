/** History tab: table, status filter, search, expandable notes. */
import { historyRows } from './templates.js';
import { firstLetterDir, noteToggleLabel } from './format.js';

export function createHistoryView() {
  const $ = (id) => document.getElementById(id);
  const table = $('historyTable');

  function enhanceNotes() {
    table.querySelectorAll('.hq-note').forEach((note) => {
      const textEl = note.querySelector('.hq-note__text');
      const more = note.querySelector('.hq-note__more');
      if (!textEl || !more) return;
      const dir = firstLetterDir(textEl.textContent);
      note.setAttribute('dir', dir);
      const open = note.classList.contains('is-open');
      const overflows = textEl.clientHeight > 0 && textEl.scrollHeight > textEl.clientHeight + 1;
      const long = overflows || textEl.textContent.trim().length > 80;
      note.classList.toggle('is-long', long);
      note.classList.toggle('is-open', open && long);
      more.hidden = !long;
      more.textContent = noteToggleLabel(dir, open && long);
      more.setAttribute('aria-expanded', open && long ? 'true' : 'false');
    });
  }

  function applyFilter() {
    const status = $('historyStatus').value;
    const query = $('historySearch').value.trim().toLowerCase();
    table.querySelectorAll('.hq-hist-item').forEach((row) => {
      const statusOk = status === 'all' || row.dataset.status === status;
      row.hidden = !(statusOk && (query === '' || (row.dataset.search || '').toLowerCase().includes(query)));
    });
  }

  function render(rows) {
    $('historyCount').textContent = String(rows.length);
    $('historyBody').innerHTML = historyRows(rows);
    applyFilter();
    enhanceNotes();
  }

  table.addEventListener('click', (event) => {
    const btn = event.target.closest('.hq-note__more');
    if (!btn) return;
    event.preventDefault();
    const note = btn.parentNode;
    const open = note.classList.contains('is-open');
    note.classList.add('is-long');
    note.classList.toggle('is-open', !open);
    btn.textContent = noteToggleLabel(note.getAttribute('dir') || 'auto', !open);
    btn.setAttribute('aria-expanded', open ? 'false' : 'true');
  });
  $('historyStatus').addEventListener('change', applyFilter);
  $('historySearch').addEventListener('input', applyFilter);

  return { render, enhanceNotes };
}
