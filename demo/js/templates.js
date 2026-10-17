/** HTML string builders. Every dynamic value goes through esc(), so these are safe to test without a DOM. */
import { esc, fmt, pretty, resource, textParts, riskOf, firstLetterDir, noteToggleLabel, unknownFields } from './format.js';
import { STATUS_TEXT, titleOf } from './i18n.js';

/** `fields` is the manifest's map of writable fields per action (optional). */
export function card(row, fields) {
  const risk = riskOf(row.action);
  const unknown = unknownFields(row, fields);
  const tag = risk === 'review' ? 'hq-tag hq-tag--warn' : 'hq-tag hq-tag--safe';
  const tagText = risk === 'review' ? 'نیازمند بررسی دقیق' : 'تغییر معمول';
  return (
    '<article class="hq-card" data-id="' + esc(row.approvalId) + '" data-risk="' + risk + '">' +
      '<div class="hq-card__main">' +
        '<input class="hq-select" type="checkbox" value="' + esc(row.approvalId) + '" aria-label="انتخاب درخواست ' + esc(row.approvalId) + '" />' +
        '<div>' +
          '<div class="hq-card__top"><div class="hq-identity">' +
            '<span class="hq-agent" aria-hidden="true">AI</span><div>' +
              '<h2 class="hq-title">' + esc(titleOf(row.action)) + '</h2>' +
              '<div class="hq-meta"><span>Hermes Agent</span>' +
              '<span class="mono">HRM-' + esc(row.approvalId) + '</span>' +
              '<span>' + esc(fmt(row.createdUtc)) + '</span>' +
              '<span>انقضا: ' + esc(fmt(row.expiresUtc)) + '</span></div>' +
            '</div></div>' +
            '<div class="hq-tags"><span class="' + tag + '">' + tagText + '</span>' +
            '<span class="hq-tag hq-tag--neutral">' + esc(row.scope) + '</span></div></div>' +
          '<div class="hq-facts">' +
            fact('شناسه منبع', resource(row)) + fact('عملیات', row.action) + fact('شناسه سایت', row.siteId) +
          '</div>' +
          '<p class="hq-reason"><strong>دلیل عامل:</strong> ' + textParts(row.reason) + '</p>' +
          (row.revisionOfApprovalId ? '<div class="hq-revision">revision درخواست HRM-' + esc(row.revisionOfApprovalId) + '</div>' : '') +
          unknownWarning(unknown) +
          '<details class="hq-details" data-id="' + esc(row.approvalId) + '"><summary>payload دقیق، مقدار فعلی و کنترل‌های تأیید</summary>' +
            '<pre class="hq-json">' + esc(pretty(row.proposal)) + '</pre>' +
            '<div class="hq-current" data-current-for="' + esc(row.approvalId) + '"></div></details>' +
        '</div></div></article>'
  );
}

function fact(label, value) {
  return '<div class="hq-fact"><span class="hq-fact__label">' + label + '</span><span class="hq-fact__value mono">' + esc(value) + '</span></div>';
}

export function queue(rows, fields) {
  return rows.length ? rows.map((r) => card(r, fields)).join('') : '<p class="hq-empty">درخواستی در انتظار تصمیم نیست.</p>';
}

function unknownWarning(names) {
  if (!names.length) return '';
  return '<p class="hq-warn" role="note"><strong>این تغییر اجرا نمی‌شود:</strong> CMS برای این فیلدها مسیر نوشتن ندارد: ' +
    names.map((n) => '<bdi dir="ltr" class="mono-inline">' + esc(n) + '</bdi>').join('، ') + '. «درخواست اصلاح» را بزنید.</p>';
}

/** Before / after table for one request. `current` is what the CMS holds now (null when it cannot be read). */
export function diffTable(current, row) {
  if (!current || typeof current !== 'object' || Array.isArray(current)) {
    return '<p class="hq-current__none">مقدار فعلی از CMS خوانده نشد.</p>';
  }
  const isDelete = /^delete:/.test(row.action || '');
  const proposal = row.proposal && typeof row.proposal === 'object' ? row.proposal : {};
  const keys = isDelete ? Object.keys(current) : Object.keys(proposal);
  const show = (v) => (v === undefined ? '—' : typeof v === 'string' ? (v === '' ? '(خالی)' : v) : JSON.stringify(v));
  const rows = keys.map((k) => {
    const now = current[k];
    const same = !isDelete && JSON.stringify(now) === JSON.stringify(proposal[k]);
    return '<tr' + (same ? ' class="is-same"' : '') + '><td class="mono">' + esc(k) + '</td>' +
      '<td><div class="hq-diff__val" dir="auto">' + esc(show(now)) + '</div></td>' +
      '<td><div class="hq-diff__val" dir="auto">' + (isDelete ? 'حذف می‌شود' : esc(show(proposal[k]))) + '</div></td></tr>';
  }).join('');
  return '<table class="hq-diff"><thead><tr><th>فیلد</th><th>مقدار فعلی</th><th>' + (isDelete ? 'پس از تأیید' : 'پیشنهاد') + '</th></tr></thead>' +
    '<tbody>' + rows + '</tbody></table>';
}

export function note(text) {
  const raw = text == null || String(text).trim() === '' ? '—' : String(text);
  const dir = firstLetterDir(raw);
  return '<div class="hq-note" dir="' + dir + '">' +
    '<p class="hq-note__text">' + esc(raw) + '</p>' +
    '<button type="button" class="hq-note__more" hidden>' + noteToggleLabel(dir, false) + '</button></div>';
}

function statusClass(status) {
  if (status === 'Consumed') return 'hq-tag hq-tag--safe';
  if (status === 'Rejected' || status === 'Expired') return 'hq-tag hq-tag--warn';
  return 'hq-tag hq-tag--neutral';
}

export function historyRows(rows) {
  return rows.map((row) => {
    const text = row.decisionReason || row.reason || '—';
    const payload = pretty(row.proposal);
    const search = ['HRM-' + row.approvalId, row.resourceType, row.resourceId, row.action, text, row.decidedBy, row.status, payload].join(' ');
    const attrs = ' data-status="' + esc(row.status) + '" data-search="' + esc(search) + '"';
    const edited = row.editedProposal ? ' <span class="hq-tag hq-tag--neutral">ویرایش‌شده توسط مدیر</span>' : '';
    const original = row.editedProposal && row.originalProposal
      ? '<div class="hq-hist-payload__box"><strong>payload عامل (قبل از ویرایش)</strong><pre class="hq-json">' + esc(pretty(row.originalProposal)) + '</pre></div>' : '';
    return '<tr class="hq-hist-item hq-hist-row"' + attrs + '>' +
      '<td><div class="hq-hist-id"><span class="mono">HRM-' + esc(row.approvalId) + '</span></div></td>' +
      '<td data-label="وضعیت"><span class="' + statusClass(row.status) + '">' + esc(STATUS_TEXT[row.status] || row.status) + '</span>' + edited + '</td>' +
      '<td class="mono" data-label="منبع">' + esc(resource(row)) + '</td>' +
      '<td class="mono" data-label="عملیات">' + esc(row.action) + '</td>' +
      '<td class="mono" data-label="تصمیم‌گیرنده">' + esc(row.decidedBy || '—') + '</td>' +
      '<td class="mono" data-label="زمان">' + esc(fmt(row.decidedUtc || row.createdUtc)) + '</td>' +
      '<td data-label="دلیل / بازخورد">' + note(text) + '</td></tr>' +
      '<tr class="hq-hist-item hq-hist-payload-row"' + attrs + '>' +
      '<td colspan="7"><details class="hq-hist-payload"><summary>جزئیات payload</summary>' +
        '<div class="hq-hist-payload__box"><pre class="hq-json">' + esc(payload) + '</pre></div>' + original +
      '</details></td></tr>';
  }).join('');
}

/** One reviewable block in the approve dialog; the payload is an editable textarea. */
export function approveItem(row, fields) {
  return '<section class="hq-dialog-item" data-id="' + esc(row.approvalId) + '">' +
    '<strong class="mono">HRM-' + esc(row.approvalId) + '</strong>' +
    '<dl><div><dt>منبع</dt><dd class="mono">' + esc(resource(row)) + '</dd></div>' +
    '<div><dt>عملیات</dt><dd class="mono">' + esc(row.action) + '</dd></div>' +
    '<div><dt>دامنه</dt><dd class="mono">' + esc(row.scope) + '</dd></div></dl>' +
    '<p><strong>دلیل عامل:</strong> ' + textParts(row.reason) + '</p>' +
    unknownWarning(unknownFields(row, fields)) +
    '<div class="hq-current" data-current-for="' + esc(row.approvalId) + '"></div>' +
    '<label class="hq-edit"><span>payload (قابل ویرایش — عامل دقیقاً همین را اجرا می‌کند)</span>' +
    '<textarea class="hq-textarea hq-json hq-edit__field" dir="ltr" spellcheck="false" rows="' + Math.min(14, pretty(row.proposal).split('\n').length + 1) + '">' +
      esc(pretty(row.proposal)) + '</textarea></label>' +
    '<p class="hq-dialog-error hq-edit__error" hidden>JSON نامعتبر است؛ باید یک شیء JSON باشد.</p>' +
    '</section>';
}
