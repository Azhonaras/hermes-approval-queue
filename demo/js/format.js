/** Pure text helpers: escaping, bidi handling, dates. No DOM access. */
export function esc(text) {
  return String(text == null ? '' : text)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function fmt(iso) {
  if (!iso) return '—';
  try { return new Date(iso).toLocaleString('fa-IR'); } catch (e) { return iso; }
}

export function pretty(obj) {
  return JSON.stringify(obj || {}, null, 2);
}

export function resource(row) {
  return row.resourceType + (row.resourceId == null ? '' : '/' + row.resourceId);
}

/**
 * Escapes agent text and wraps each run of non-Persian words in ONE LTR <bdi>, so an English phrase keeps its word
 * order inside an RTL sentence. (One <bdi> per word reversed the words; a Persian word was once left unescaped, which
 * let the agent's reason run script in the reviewer's page.) Every character goes through esc().
 */
export function textParts(text) {
  const out = [];
  let run = ''; // Latin words and the spaces between them
  let gap = ''; // spaces after the run that belong to it only if another Latin word follows
  const flush = () => {
    if (run) out.push('<bdi dir="ltr" class="mono-inline">' + esc(run) + '</bdi>');
    run = '';
  };
  for (const part of String(text == null ? '' : text).split(/(\s+)/)) {
    if (!part) continue;
    if (/^\s+$/.test(part)) {
      if (run) gap += part; else out.push(esc(part));
    } else if (/[؀-ۿ]/.test(part)) {
      flush();
      out.push(esc(gap) + esc(part));
      gap = '';
    } else {
      run += gap + part;
      gap = '';
    }
  }
  flush();
  return out.join('') + esc(gap);
}

/** Direction of the first strong letter: 'ltr', 'rtl' or 'auto'. */
export function firstLetterDir(text) {
  const s = String(text == null ? '' : text);
  for (let i = 0; i < s.length; i += 1) {
    const ch = s.charAt(i);
    const c = s.charCodeAt(i);
    if (/\s/.test(ch)) continue;
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 0x00C0 && c <= 0x024F && c !== 0x00D7 && c !== 0x00F7)) return 'ltr';
    if ((c >= 0x0600 && c <= 0x06FF) || (c >= 0x0750 && c <= 0x077F) || (c >= 0x08A0 && c <= 0x08FF) ||
        (c >= 0xFB50 && c <= 0xFDFF) || (c >= 0xFE70 && c <= 0xFEFF)) return 'rtl';
  }
  return 'auto';
}

export function noteToggleLabel(dir, open) {
  if (dir === 'ltr') return open ? 'less' : 'more';
  return open ? 'کمتر' : 'بیشتر';
}

export function riskOf(action) {
  return /canonical|redirect|delete|merge|schema|:content$/.test(action || '') ? 'review' : 'routine';
}

/**
 * Proposal fields the CMS has no write path for, when the manifest lists them (`fields[action]`).
 * A reviewer should not approve a change that can never run; the card warns instead.
 */
export function unknownFields(row, fields) {
  const allowed = fields && fields[row.action];
  if (!Array.isArray(allowed) || !row.proposal || typeof row.proposal !== 'object') return [];
  return Object.keys(row.proposal).filter((k) => !allowed.includes(k));
}

/** Parses reviewer-edited JSON. Returns { value } or { error }. */
export function parseProposal(text) {
  try {
    const value = JSON.parse(text);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return { error: 'object' };
    return { value };
  } catch (e) {
    return { error: 'syntax' };
  }
}
