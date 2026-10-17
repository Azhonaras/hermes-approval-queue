/** Approve (with payload editing), reject and request-changes dialogs. Calls back with the decision. */
import { approveItem, diffTable } from './templates.js';
import { parseProposal, pretty } from './format.js';

const $ = (id) => document.getElementById(id);

export function openDialog(id) {
  const d = $(id);
  if (d.showModal) d.showModal(); else d.setAttribute('open', 'open');
}
export function closeDialog(id) {
  const d = $(id);
  if (d.close) d.close(); else d.removeAttribute('open');
}
export function anyDialogOpen() {
  return Array.from(document.querySelectorAll('dialog.hq-dialog')).some((d) => d.open || d.hasAttribute('open'));
}

/**
 * Reads the edited payloads out of the approve dialog.
 * Returns { edits: { id: object } } for payloads that differ from the agent's, or { invalid: true }.
 */
export function collectEdits(rows, root = $('approveSummary')) {
  const edits = {};
  let invalid = false;
  rows.forEach((row) => {
    const section = root.querySelector('[data-id="' + row.approvalId + '"]');
    const field = section.querySelector('.hq-edit__field');
    const error = section.querySelector('.hq-edit__error');
    const parsed = parseProposal(field.value);
    error.hidden = !parsed.error;
    field.setAttribute('aria-invalid', parsed.error ? 'true' : 'false');
    if (parsed.error) { invalid = true; return; }
    if (JSON.stringify(parsed.value) !== JSON.stringify(row.proposal)) edits[row.approvalId] = parsed.value;
  });
  return invalid ? { invalid } : { edits };
}

export function initDialogs({ getRows, getIds, onDecide, getFields = () => null, loadCurrent = () => Promise.resolve(null) }) {
  document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => closeDialog(b.dataset.close)));

  $('approveSelected').addEventListener('click', () => {
    const rows = getRows();
    $('approveSummary').innerHTML = rows.map((r) => approveItem(r, getFields())).join('');
    // The final check shows before and after, not only the new JSON.
    rows.forEach((row) => {
      const box = $('approveSummary').querySelector('.hq-current[data-current-for="' + row.approvalId + '"]');
      if (box) loadCurrent(row).then((current) => { box.innerHTML = diffTable(current, row); });
    });
    $('approveAcknowledge').checked = false;
    $('confirmApprove').disabled = true;
    openDialog('approveDialog');
  });
  $('approveAcknowledge').addEventListener('change', function () { $('confirmApprove').disabled = !this.checked; });
  $('confirmApprove').addEventListener('click', () => {
    const result = collectEdits(getRows());
    if (result.invalid) return;
    closeDialog('approveDialog');
    onDecide('approve', '', result.edits);
  });

  [['rejectSelected', 'rejectDialog', 'rejectSummary', 'rejectReason', 'rejectError', 'confirmReject', 'reject'],
   ['requestChanges', 'changesDialog', 'changesSummary', 'changesReason', 'changesError', 'confirmChanges', 'request-changes']]
    .forEach(([open, dialog, summary, reason, error, confirm, verb]) => {
      $(open).addEventListener('click', () => {
        $(summary).textContent = getIds().map((id) => 'HRM-' + id).join('، ');
        $(reason).value = '';
        $(error).hidden = true;
        openDialog(dialog);
      });
      $(confirm).addEventListener('click', () => {
        const value = $(reason).value.trim();
        $(error).hidden = !!value;
        if (!value) return;
        closeDialog(dialog);
        onDecide(verb, value, {});
      });
    });
}

export { pretty };
