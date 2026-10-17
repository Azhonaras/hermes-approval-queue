/** One system under test, as the fuzzer sees it: fills in its own ids and keys, sends the request, boils the answer down to a comparable line. */
import { rawRequest } from '../rawhttp.mjs';
import { SUBMISSION_BYTES } from './families.mjs';

const pair = (line) => { const i = line.indexOf(':'); return [line.slice(0, i).trim(), line.slice(i + 1).trim()]; };
const fill = (text, vars) => text.replace(/\{\{(\w+)\}\}/g, (m, name) => (vars[name] !== undefined ? vars[name] : m));
const fillBytes = (buf, vars) => Buffer.from(fill(buf.toString('latin1'), vars), 'latin1'); // ASCII placeholders only; every other byte passes through untouched

/** What a target's line says when a web server in front of it refused the request before the CMS ran (see `refusedByWebServer`). */
export const WEB_SERVER_REFUSED = 'WEB-SERVER-REFUSED';
/** A "%" without two hex digits after it, in the path part of a request target. Web servers do not look into a query string. */
const hasMalformedEscape = (target) => /%(?![0-9a-fA-F]{2})/.test(target.split('?')[0]);

export function makeTarget(config, label) {
  const [, readKey] = pair(config.readHeader);
  const [, writeKey] = pair(config.writeHeader);
  const identities = { none: {}, read: Object.fromEntries([pair(config.readHeader)]), write: Object.fromEntries([pair(config.writeHeader)]), review: Object.fromEntries(config.reviewHeaders.map(pair)) };
  identities.writeAndReview = { ...identities.write, ...identities.review };
  const constants = { type: config.resourceType, rid: String(config.resourceId), readKey, writeKey, READKEY: readKey.toUpperCase(), WRITEKEY: writeKey.toUpperCase() };
  const timeoutMs = config.timeoutMs || 30000;

  const send = (opts) => rawRequest(config.baseUrl, { timeoutMs, ...opts });
  const json = (res) => { try { return JSON.parse(res.text); } catch { return null; } };

  async function makeRow(kind) {
    const created = await send({ method: 'POST', path: '/proposals', headers: { ...identities.write, 'Content-Type': 'application/json; charset=utf-8' }, body: SUBMISSION_BYTES });
    const row = json(created)?.data;
    if (!row) throw new Error(`could not submit the setup row: HTTP ${created.http} ${created.text.slice(0, 120)}`);
    if (kind === 'approved') {
      const decided = await send({ method: 'POST', path: `/proposals/${row.approvalId}/approve`, headers: { ...identities.review, 'Content-Type': 'application/json; charset=utf-8' }, body: '{"reason":""}' });
      if (!json(decided)?.success) throw new Error(`could not approve the setup row: HTTP ${decided.http} ${decided.text.slice(0, 120)}`);
    }
    return row.approvalId;
  }

  /**
   * nginx and Apache answer a malformed percent-escape in the path with their own 400 before the application runs, whoever asks.
   * That says nothing about the CMS, so such an answer is left out of the comparison, but only when the same escape gets the same
   * non-JSON 400 outside the CMS's URL space, where no CMS route can have answered. A CMS at the root of its host has no outside.
   */
  let outsideRefuses;
  async function webServerRefusesBrokenEscapes() {
    if (outsideRefuses === undefined) {
      const u = new URL(config.baseUrl);
      if (u.pathname.replace(/\/$/, '') === '') outsideRefuses = false;
      else {
        const res = await rawRequest(u.origin, { path: '/%zz', headers: { Accept: 'application/json' }, timeoutMs });
        outsideRefuses = res.http === 400 && json(res) === null;
      }
    }
    return outsideRefuses;
  }

  /** Runs one spec; returns { line, res } where `line` is what gets compared across targets. */
  async function run(spec) {
    const vars = { ...constants };
    if (spec.setup) {
      try { vars.approvalId = String(await makeRow(spec.setup)); } catch (e) { return { line: 'SETUP-FAILED ' + e.message.replace(/\d+/g, 'N').slice(0, 80), res: null }; }
    }
    const headers = { Accept: 'application/json', ...identities[spec.who] };
    for (const [k, v] of Object.entries(spec.headers || {})) headers[k] = fill(v, vars);
    const hasBody = spec.body !== undefined || spec.chunks !== undefined;
    if (hasBody) {
      if (spec.contentType === undefined) headers['Content-Type'] = 'application/json; charset=utf-8';
      else if (spec.contentType !== null) headers['Content-Type'] = spec.contentType;
    }
    const res = await send({
      method: spec.method, path: fill(spec.path, vars), headers,
      body: spec.body === undefined ? undefined : fillBytes(spec.body, vars),
      chunks: spec.chunks ? spec.chunks.map((c) => fillBytes(c, vars)) : undefined
    });
    if (res.http === 400 && json(res) === null && hasMalformedEscape(spec.path || '') && await webServerRefusesBrokenEscapes()) return { line: WEB_SERVER_REFUSED, res };
    return { line: summarize(res, spec), res };
  }

  return { label, config, run };
}

const DROP = new Set(['approvalId', 'createdUtc', 'decidedUtc', 'expiresUtc', 'decidedBy']); // legitimately different per stack and per run

const canonical = (v) => (Array.isArray(v) ? '[' + v.map(canonical).join(',') + ']'
  : v && typeof v === 'object' ? '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}' : JSON.stringify(v));

/** "HTTP status + error code", plus what the server echoed back when that is part of the contract. */
export function summarize(res, spec) {
  // The Node http client itself refused to send this (a control character in a header, a space in the path): nothing reached the server.
  if (res.failed && res.text.startsWith('could not send')) return 'CLIENT-REFUSED';
  if (res.failed) return 'NO-RESPONSE ' + res.text.replace(/\d+/g, 'N');
  let body = null;
  try { body = JSON.parse(res.text); } catch { /* not JSON */ }
  const code = body && body.error && body.error.code ? body.error.code : body && body.success ? 'ok' : body ? 'other-json' : 'not-json';
  if (spec.compare === 'guard' && (res.http === 200 || (res.http === 502 && code === 'WRITE_FAILED'))) return 'guard-passed';
  // A NUL (%00) in the path is a 400 everywhere, but Kestrel and some other servers refuse it before the application runs, with their own body.
  if (/%00/.test(spec.path || '')) return String(res.http);
  let line = `${res.http} ${code}`;
  if (spec.compare === 'echo' && body && body.success && body.data && typeof body.data === 'object' && !Array.isArray(body.data)) {
    const kept = Object.fromEntries(Object.entries(body.data).filter(([k]) => !DROP.has(k)));
    line += ' ' + canonical(kept);
  }
  return line;
}
