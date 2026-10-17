/**
 * Test context: one place that knows how to talk to the target CMS.
 * Every check receives `ctx` and never builds URLs or headers itself.
 */
import { randomBytes } from 'node:crypto';
import { timedFetch, DEFAULT_TIMEOUT_MS } from './http.mjs';
import { rawRequest } from './rawhttp.mjs';

export const WHO = ['none', 'read', 'write', 'review', 'writeAndReview'];

function headerLine(line) {
  const i = line.indexOf(':');
  if (i < 1) throw new Error('Header must look like "Name: value", got: ' + line);
  return [line.slice(0, i).trim(), line.slice(i + 1).trim()];
}

export function createContext(config) {
  const base = config.baseUrl.replace(/\/$/, '');
  const identities = {
    none: {},
    read: Object.fromEntries([headerLine(config.readHeader)]),
    write: Object.fromEntries([headerLine(config.writeHeader)]),
    review: Object.fromEntries(config.reviewHeaders.map(headerLine))
  };
  identities.writeAndReview = { ...identities.write, ...identities.review };

  const unique = () => randomBytes(4).toString('hex');
  const timeoutMs = config.timeoutMs || DEFAULT_TIMEOUT_MS;

  /** Raw call: returns { http, json, text, headers }. Never throws on HTTP errors. */
  async function call(who, method, path, body, { rawBody, extraHeaders } = {}) {
    const headers = { Accept: 'application/json', ...identities[who], ...extraHeaders };
    let payload;
    if (rawBody !== undefined) payload = rawBody;
    else if (body !== undefined) payload = JSON.stringify(body);
    if (payload !== undefined) headers['Content-Type'] = 'application/json; charset=utf-8';
    const res = await timedFetch(base + path, { method, headers, body: payload }, timeoutMs);
    let json = null;
    try { json = JSON.parse(res.text); } catch { /* non-JSON response */ }
    return { http: res.http, json, text: res.text, headers: res.headers };
  }

  /** Like call(), but `rawPath` is sent exactly as written (no "..", "%2e%2e" or "\\" resolution). */
  async function callRaw(who, method, rawPath, { extraHeaders, body } = {}) {
    const res = await rawRequest(base, { method, path: rawPath, headers: { Accept: 'application/json', ...identities[who], ...extraHeaders }, body, timeoutMs });
    let json = null;
    try { json = JSON.parse(res.text); } catch { /* non-JSON response */ }
    return { http: res.http, json, text: res.text, headers: res.headers };
  }

  /**
   * A request to the same web server but outside the CMS's URL space, sent exactly as written. Null when the CMS is mounted at
   * the root of its host: there is no "outside" then, so nothing a web server in front of it did can be told apart from the CMS.
   */
  async function callOutside(method, rawPath, { extraHeaders } = {}) {
    const u = new URL(base);
    if (u.pathname.replace(/\/$/, '') === '') return null;
    const res = await rawRequest(u.origin, { method, path: rawPath, headers: { Accept: 'application/json', ...extraHeaders }, timeoutMs });
    let json = null;
    try { json = JSON.parse(res.text); } catch { /* non-JSON response */ }
    return { http: res.http, json, text: res.text, headers: res.headers };
  }

  const data = (r) => (r.json && r.json.success ? r.json.data : null);
  const code = (r) => (r.json && r.json.error ? r.json.error.code : null);

  /** A fresh, valid submission body. `payload` keeps every call unique so rows never collide. */
  function submission(extra = {}) {
    const id = unique();
    const payload = JSON.parse(JSON.stringify(config.payload).replaceAll('{{uid}}', id));
    return {
      siteId: config.siteId,
      resourceType: config.resourceType,
      resourceId: config.resourceId,
      action: config.action,
      scope: config.scope,
      reason: 'conformance ' + id,
      proposal: payload,
      ...extra
    };
  }

  async function submit(extra) {
    const res = await call('write', 'POST', '/proposals', submission(extra));
    if (!data(res)) throw new Error('Could not submit a proposal: HTTP ' + res.http + ' ' + res.text.slice(0, 200));
    return data(res);
  }

  async function decide(id, verb, body = {}) {
    return call('review', 'POST', '/proposals/' + id + '/' + verb, body);
  }

  async function approved(extra) {
    const row = await submit(extra);
    const res = await decide(row.approvalId, 'approve', { reason: '' });
    if (!data(res)) throw new Error('Could not approve: HTTP ' + res.http + ' ' + res.text.slice(0, 200));
    return data(res);
  }

  const writeBody = (row, extra = {}) => ({
    approvalId: row.approvalId,
    resourceType: row.resourceType,
    resourceId: row.resourceId,
    action: row.action,
    scope: row.scope,
    proposal: row.proposal,
    ...extra
  });

  const execute = (row, extra) => call('write', 'POST', '/writes', writeBody(row, extra));

  async function readVerifyUrl(headers) {
    const res = await timedFetch(config.verifyUrl, { headers: { Accept: 'application/json', ...headers } }, timeoutMs);
    if (res.failed) throw new Error('Could not read ' + config.verifyUrl + ': ' + res.text);
    try { return JSON.parse(res.text); } catch { return null; }
  }

  /** Reads the field the CMS should change, through a path that does NOT use the approval API. */
  async function observe() {
    if (!config.verifyUrl) return undefined;
    const headers = Object.fromEntries((config.verifyHeaders || []).map(headerLine));
    const json = await readVerifyUrl(headers);
    const node = json && json.data !== undefined ? json.data : json;
    return config.verifyField.split('.').reduce((o, k) => (o == null ? undefined : o[k]), node);
  }

  /** The whole resource as the CMS shows it, for before/after comparisons. */
  async function observeResource() {
    if (!config.verifyUrl) return undefined;
    const headers = Object.fromEntries((config.verifyHeaders || []).map(headerLine));
    const json = await readVerifyUrl(headers);
    return json && json.data !== undefined ? json.data : json;
  }

  return { config, call, callRaw, callOutside, data, code, submission, submit, decide, approved, writeBody, execute, observe, observeResource, unique, base };
}
