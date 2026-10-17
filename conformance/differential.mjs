/**
 * Differential probe: sends the same awkward and hostile requests to several implementations and prints
 * a table of "HTTP status + error code" per stack, marking rows where the stacks disagree.
 * Disagreement is where bugs live: two stacks reading the same bytes differently.
 *
 *   node conformance/differential.mjs --config a.json --config b.json [--config c.json ...]
 *
 * Uses the same profile files as run.mjs (baseUrl, keys, review headers, resource, action, payload).
 * Local test targets only: it submits, approves and writes many rows.
 */
import fs from 'node:fs';
import { buildConfig, isLocal } from './config.mjs';
import { timedFetch } from './http.mjs';
import { rawRequest } from './rawhttp.mjs';

const files = process.argv.slice(2).filter((a, i, all) => all[i - 1] === '--config');
if (files.length < 2) { console.error('usage: node conformance/differential.mjs --config a.json --config b.json ...'); process.exit(2); }

const header = (line) => { const i = line.indexOf(':'); return [line.slice(0, i).trim(), line.slice(i + 1).trim()]; };

function cases(c) {
  const W = { ...Object.fromEntries([header(c.writeHeader)]), 'Content-Type': 'application/json' };
  const RD = Object.fromEntries([header(c.readHeader)]);
  const RV = { ...Object.fromEntries(c.reviewHeaders.map(header)), 'Content-Type': 'application/json' };
  const uid = () => Math.random().toString(36).slice(2, 8);
  const payload = () => JSON.parse(JSON.stringify(c.payload).replaceAll('{{uid}}', uid()));
  const key = Object.keys(c.payload)[0];
  const sub = (extra = {}) => ({ siteId: 1, resourceType: c.resourceType, resourceId: c.resourceId, action: c.action, scope: c.scope, reason: 'probe', proposal: payload(), ...extra });
  const subRaw = (proposalJson, extra = '') => `{"siteId":1,"resourceType":${JSON.stringify(c.resourceType)},"resourceId":${JSON.stringify(c.resourceId)},"action":${JSON.stringify(c.action)},"scope":${JSON.stringify(c.scope)},"reason":"probe"${extra},"proposal":${proposalJson}}`;

  async function call(method, path, headers, body, raw) {
    try {
      const res = await timedFetch(c.baseUrl + path, { method, headers, body: raw !== undefined ? raw : body === undefined ? undefined : JSON.stringify(body) }, c.timeoutMs);
      if (res.failed) return { http: 0, code: 'NETWORK', json: null, text: res.text };
      let json = null;
      try { json = JSON.parse(res.text); } catch { /* not JSON */ }
      const code = json && json.error && json.error.code ? json.error.code : json && json.success ? 'ok' : json ? 'other-json' : 'not-json';
      return { http: res.http, code, json, text: res.text };
    } catch (e) { return { http: 0, code: 'NETWORK', json: null, text: String(e) }; }
  }
  /** Like call(), but the path goes out exactly as written: fetch() would resolve "..", "%2e%2e" and "\\" first. */
  async function callPath(method, path, headers = {}) {
    const res = await rawRequest(c.baseUrl, { method, path, headers, timeoutMs: c.timeoutMs });
    if (res.failed) return { http: 0, code: 'NETWORK', json: null, text: res.text };
    let json = null;
    try { json = JSON.parse(res.text); } catch { /* not JSON */ }
    const code = json && json.error && json.error.code ? json.error.code : json && json.success ? 'ok' : json ? 'other-json' : 'not-json';
    return { http: res.http, code, json, text: res.text };
  }
  /** A web framework may refuse a request before the application runs and answer in its own body; only the status can be compared then. */
  const statusOnly = async (promise) => { const r = await promise; return { http: r.http, code: '-' }; };
  const submit = async (extra) => (await call('POST', '/proposals', W, sub(extra))).json?.data;
  const approved = async (extra, decideBody = { reason: '' }) => {
    const row = await submit(extra);
    if (!row) return null;
    return (await call('POST', `/proposals/${row.approvalId}/approve`, RV, decideBody)).json?.data;
  };
  const writeOf = (row, extra = {}) => ({ approvalId: row.approvalId, resourceType: row.resourceType, resourceId: row.resourceId, action: row.action, scope: row.scope, proposal: row.proposal, ...extra });
  const P = (path) => call('POST', path, W, undefined, undefined);

  return [
    // size and text
    ['8000 Persian characters', () => call('POST', '/proposals', W, sub({ proposal: { [key]: 'ب'.repeat(8000) } }))],
    ['4000 emoji', () => call('POST', '/proposals', W, sub({ proposal: { [key]: '🙂'.repeat(4000) } }))],
    ['exactly 16384 characters', () => call('POST', '/proposals', W, sub({ proposal: { [key]: 'a'.repeat(16384 - JSON.stringify({ [key]: '' }).length) } }))],
    ['16385 characters', () => call('POST', '/proposals', W, sub({ proposal: { [key]: 'a'.repeat(16385 - JSON.stringify({ [key]: '' }).length) } }))],
    ['reason 1024 / 1025', async () => { const a = await call('POST', '/proposals', W, sub({ reason: 'r'.repeat(1024) })); const b = await call('POST', '/proposals', W, sub({ reason: 'r'.repeat(1025) })); return { http: a.http + '/' + b.http, code: a.code + '/' + b.code }; }],
    ['reason 1024 emoji (2048 UTF-16 units)', () => call('POST', '/proposals', W, sub({ reason: '🙂'.repeat(1024) }))],
    ['40 / 41 fields', async () => { const a = await call('POST', '/proposals', W, sub({ proposal: Object.fromEntries(Array.from({ length: 40 }, (_, i) => ['f' + i, i])) })); const b = await call('POST', '/proposals', W, sub({ proposal: Object.fromEntries(Array.from({ length: 41 }, (_, i) => ['f' + i, i])) })); return { http: a.http + '/' + b.http, code: a.code + '/' + b.code }; }],
    // parsing
    ['duplicate key in proposal', () => call('POST', '/proposals', W, undefined, subRaw('{"a":"1","a":"2"}'))],
    ['duplicate top-level key', () => call('POST', '/proposals', W, undefined, subRaw('{"a":"1"}', ',"reason":"twice"'))],
    // Depth counts every container in the body: the body object is level 1, the proposal object level 2, then the arrays.
    ['32 levels of nesting in total', () => call('POST', '/proposals', W, undefined, subRaw('{"a":' + '['.repeat(30) + ']'.repeat(30) + '}'))],
    ['33 levels of nesting in total', () => call('POST', '/proposals', W, undefined, subRaw('{"a":' + '['.repeat(31) + ']'.repeat(31) + '}'))],
    ['33 levels, innermost array empty', () => call('POST', '/proposals', W, undefined, subRaw('{"a":' + '['.repeat(30) + '[]' + ']'.repeat(30) + '}'))],
    ['invalid UTF-8', () => call('POST', '/proposals', W, undefined, Buffer.concat([Buffer.from(subRaw('{"a":"').slice(0, -1)), Buffer.from([0x22, 0xff, 0xfe, 0x22, 0x7d, 0x7d])]))],
    ['UTF-8 encoded surrogate (CESU)', () => call('POST', '/proposals', W, undefined, Buffer.concat([Buffer.from(subRaw('"').slice(0, -1)), Buffer.from([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0xed, 0xa0, 0x80, 0x22, 0x7d, 0x7d])]))],
    ['lone surrogate escape', () => call('POST', '/proposals', W, undefined, subRaw('{"a":"\\ud800"}'))],
    ['NUL in a value', () => call('POST', '/proposals', W, sub({ proposal: { [key]: 'a\u0000b' } }))],
    ['NUL in a key', () => call('POST', '/proposals', W, undefined, subRaw('{"\\u0000k":"v"}'))],
    ['empty key', () => call('POST', '/proposals', W, undefined, subRaw('{"":"v"}'))],
    ['key "0" and "00"', async () => { const r = await call('POST', '/proposals', W, undefined, subRaw('{"0":"a","00":"b"}')); return { http: r.http, code: r.code + ' ' + JSON.stringify(r.json?.data?.proposal) }; }],
    ['empty object vs array kept', async () => { const r = await call('POST', '/proposals', W, undefined, subRaw('{"o":{},"l":[]}')); return { http: r.http, code: r.code + ' ' + JSON.stringify(r.json?.data?.proposal) }; }],
    ['number 1e999', () => call('POST', '/proposals', W, undefined, subRaw('{"n":1e999}'))],
    ['number -0', async () => { const r = await call('POST', '/proposals', W, undefined, subRaw('{"n":-0}')); return { http: r.http, code: r.code + ' ' + JSON.stringify(r.json?.data?.proposal) }; }],
    ['big integer stored as', async () => { const r = await call('POST', '/proposals', W, undefined, subRaw('{"n":12345678901234567890,"m":0.1}')); return { http: r.http, code: r.code + ' ' + (r.text.match(/"proposal":\{[^}]*\}/) || [''])[0] }; }],
    ['BOM before body', () => call('POST', '/proposals', W, undefined, '﻿' + JSON.stringify(sub()))],
    ['trailing garbage', () => call('POST', '/proposals', W, undefined, JSON.stringify(sub()) + ' x')],
    ['empty body', () => call('POST', '/proposals', W, undefined, '')],
    ['body is an array', () => call('POST', '/proposals', W, [1])],
    ['body is null', () => call('POST', '/proposals', W, undefined, 'null')],
    ['text/plain content type', () => call('POST', '/proposals', { ...W, 'Content-Type': 'text/plain' }, sub())],
    ['__proto__ key kept as data', async () => { const r = await call('POST', '/proposals', W, undefined, subRaw('{"__proto__":{"admin":true},"b":"1"}')); return { http: r.http, code: r.code + ' ' + JSON.stringify(r.json?.data?.proposal) }; }],
    // types and trimming
    ['siteId "1"', () => call('POST', '/proposals', W, sub({ siteId: '1' }))],
    ['siteId 1.0', () => call('POST', '/proposals', W, undefined, subRaw('{"a":"b"}').replace('"siteId":1', '"siteId":1.0'))],
    ['siteId 1.5', () => call('POST', '/proposals', W, sub({ siteId: 1.5 }))],
    ['resourceId true / {} / []', async () => { const r = await Promise.all([true, {}, []].map((v) => call('POST', '/proposals', W, sub({ resourceId: v })))); return { http: r.map((x) => x.http).join('/'), code: r.map((x) => x.code).join('/') }; }],
    ['resourceId 42.0 stored as', async () => { const r = await call('POST', '/proposals', W, undefined, subRaw('{"a":"b"}').replace(`"resourceId":${JSON.stringify(c.resourceId)}`, '"resourceId":42.0')); return { http: r.http, code: r.code + ' ' + JSON.stringify(r.json?.data?.resourceId) }; }],
    ['resourceId 200 / 201 chars of JSON', async () => { const a = await call('POST', '/proposals', W, sub({ resourceId: 'x'.repeat(198) })); const b = await call('POST', '/proposals', W, sub({ resourceId: 'x'.repeat(199) })); return { http: a.http + '/' + b.http, code: a.code + '/' + b.code }; }],
    ['resourceType with BOM / NBSP around it', async () => { const r = await call('POST', '/proposals', W, sub({ resourceType: '﻿' + c.resourceType + ' ' })); return { http: r.http, code: r.code + ' ' + JSON.stringify(r.json?.data?.resourceType) }; }],
    ['resourceType with U+0085 around it', async () => { const r = await call('POST', '/proposals', W, sub({ resourceType: '\u0085' + c.resourceType })); return { http: r.http, code: r.code + ' ' + JSON.stringify(r.json?.data?.resourceType) }; }],
    ['reason 12 (number)', () => call('POST', '/proposals', W, sub({ reason: 12 }))],
    ['action 5 (number)', () => call('POST', '/proposals', W, sub({ action: 5 }))],
    ['revisionOf "abc" / 0 / -1', async () => { const r = await Promise.all(['abc', 0, -1].map((v) => call('POST', '/proposals', W, sub({ revisionOfApprovalId: v })))); return { http: r.map((x) => x.http).join('/'), code: r.map((x) => x.code).join('/') }; }],
    // decisions
    ['approve with reason 5 (number)', async () => { const row = await submit(); return call('POST', `/proposals/${row.approvalId}/approve`, RV, { reason: 5 }); }],
    ['reject with reason 5 (number)', async () => { const row = await submit(); return call('POST', `/proposals/${row.approvalId}/reject`, RV, { reason: 5 }); }],
    ['reject with reason "   " (blank)', async () => { const row = await submit(); return call('POST', `/proposals/${row.approvalId}/reject`, RV, { reason: '   ' }); }],
    ['reject with a 5000-character reason', async () => { const row = await submit(); return call('POST', `/proposals/${row.approvalId}/reject`, RV, { reason: 'r'.repeat(5000) }); }],
    ['approve with proposal: null', async () => { const row = await submit(); return call('POST', `/proposals/${row.approvalId}/approve`, RV, { reason: '', proposal: null }); }],
    ['approve with proposal: {} (non-delete)', async () => { const row = await submit(); return call('POST', `/proposals/${row.approvalId}/approve`, RV, { reason: '', proposal: {} }); }],
    ['approve with the same proposal (not an edit)', async () => { const row = await submit(); const r = await call('POST', `/proposals/${row.approvalId}/approve`, RV, { reason: '', proposal: row.proposal }); return { http: r.http, code: r.code + ' edited=' + r.json?.data?.editedProposal }; }],
    ['request-changes carrying a proposal', async () => { const row = await submit(); return call('POST', `/proposals/${row.approvalId}/request-changes`, RV, { reason: 'x', proposal: payload() }); }],
    ['approve with body []', async () => { const row = await submit(); return call('POST', `/proposals/${row.approvalId}/approve`, RV, undefined, '[]'); }],
    ['approve with empty body', async () => { const row = await submit(); return call('POST', `/proposals/${row.approvalId}/approve`, RV, undefined, ''); }],
    // writes
    ['write resourceId "42" vs 42', async () => { const row = await approved(); return call('POST', '/writes', W, writeOf(row, { resourceId: String(row.resourceId) })); }],
    ['write with 1.0 for 1 and 1.05e1 for 10.5', async () => { const row = await approved(); const raw = JSON.stringify(writeOf(row)); return call('POST', '/writes', W, undefined, raw.replace(`"approvalId":${row.approvalId}`, `"approvalId":${row.approvalId}.0`)); }],
    ['write approvalId "123" (string)', async () => { const row = await approved(); return call('POST', '/writes', W, writeOf(row, { approvalId: String(row.approvalId) })); }],
    ['write siteId null', async () => { const row = await approved(); return call('POST', '/writes', W, writeOf(row, { siteId: null })); }],
    ['write siteId 1.0', async () => { const row = await approved(); return call('POST', '/writes', W, undefined, JSON.stringify(writeOf(row, { siteId: 1 })).replace('"siteId":1', '"siteId":1.0')); }],
    ['write siteId 2', async () => { const row = await approved(); return call('POST', '/writes', W, writeOf(row, { siteId: 2 })); }],
    ['delete action: write with proposal false', async () => { const row = await approved({ action: c.deleteAction || 'delete:taxonomy', proposal: {}, resourceId: c.otherResourceId }); return call('POST', '/writes', W, writeOf(row, { proposal: false })); }],
    ['delete action: write without proposal', async () => { const row = await approved({ action: c.deleteAction || 'delete:taxonomy', proposal: {}, resourceId: c.otherResourceId }); const w = writeOf(row); delete w.proposal; const r = await call('POST', '/writes', W, w); return { http: r.http === 502 ? '200|502' : r.http, code: r.http === 502 ? 'guard-passed' : r.code }; }],
    // routing and ids
    ['GET /resources/{type}/0042', () => call('GET', `/resources/${c.resourceType}/00${c.resourceId}`, RD)],
    ['GET /resources/{type}/%34%32 (percent-encoded)', () => call('GET', `/resources/${c.resourceType}/${[...String(c.resourceId)].map((ch) => '%' + ch.charCodeAt(0).toString(16)).join('')}`, RD)],
    ['GET /resources/{type}/+42', () => call('GET', `/resources/${c.resourceType}/+${c.resourceId}`, RD)],
    ['GET /resources/{type}/42?siteId=abc', () => call('GET', `/resources/${c.resourceType}/${c.resourceId}?siteId=abc`, RD)],
    ['GET /resources/{type}/42?siteId=2', () => call('GET', `/resources/${c.resourceType}/${c.resourceId}?siteId=2`, RD)],
    ['GET /resources/{type}/%2534%2532 (must not be decoded twice)', () => call('GET', `/resources/${c.resourceType}/%2534%2532`, RD)],
    ['GET /resources/{type}/4%2F2 (encoded slash stays inside the segment)', async () => { const r = await call('GET', `/resources/${c.resourceType}/4%2F2`, RD); return { http: r.http, code: r.http >= 500 ? r.code : '4xx' }; }],
    ['GET /resources/{type}/%zz (malformed percent-encoding; status only)', () => statusOnly(call('GET', `/resources/${c.resourceType}/%zz`, RD))],
    ['GET /resources/{type}/%FF (invalid UTF-8 after decoding)', async () => { const r = await call('GET', `/resources/${c.resourceType}/%FF`, RD); return { http: r.http, code: r.code }; }],
    ['GET /resources/{type}/42%0A (a number followed by a newline is a string)', () => callPath('GET', `/resources/${encodeURIComponent(c.resourceType)}/${c.resourceId}%0A`, RD)],
    ['GET /resources/{type}/%0A42 (newline before the number)', () => callPath('GET', `/resources/${encodeURIComponent(c.resourceType)}/%0A${c.resourceId}`, RD)],
    ['GET /resources/{type}/42%20 (trailing space)', () => callPath('GET', `/resources/${encodeURIComponent(c.resourceType)}/${c.resourceId}%20`, RD)],
    ['GET /resources/{type}/42%00 (NUL; status only)', () => statusOnly(callPath('GET', `/resources/${encodeURIComponent(c.resourceType)}/${c.resourceId}%00`, RD))],
    ['GET /resources/{type}/42?siteId=1%0A (newline after the site id)', () => callPath('GET', `/resources/${encodeURIComponent(c.resourceType)}/${c.resourceId}?siteId=1%0A`, RD)],
    ['GET /resources/{type}/42?siteId=%EF%BC%91 (full-width digit)', () => callPath('GET', `/resources/${encodeURIComponent(c.resourceType)}/${c.resourceId}?siteId=%EF%BC%91`, RD)],
    ['GET /proposals/../ping (dot segments are not resolved)', () => callPath('GET', '/proposals/../ping')],
    ['GET /proposals/%2e%2e/ping', () => callPath('GET', '/proposals/%2e%2e/ping')],
    ['GET \\ping (a backslash is not a slash; status only)', () => statusOnly(callPath('GET', '\\ping'))],
    ['GET /ping%00 (NUL in a fixed route; status only)', () => statusOnly(callPath('GET', '/ping%00'))],
    ['GET /resources/{type}/42?siteId=1&siteId=2 (first wins)', () => call('GET', `/resources/${c.resourceType}/${c.resourceId}?siteId=1&siteId=2`, RD)],
    ['GET /resources/{type}/42?siteId=2&siteId=1 (first wins)', () => call('GET', `/resources/${c.resourceType}/${c.resourceId}?siteId=2&siteId=1`, RD)],
    ['GET /resources/{type}/42?siteId=%31', () => call('GET', `/resources/${c.resourceType}/${c.resourceId}?siteId=%31`, RD)],
    ['GET /resources/{type}/42?siteId[]=1', () => call('GET', `/resources/${c.resourceType}/${c.resourceId}?siteId[]=1`, RD)],
    ['GET /proposals?status= (empty)', () => call('GET', '/proposals?status=', RV)],
    ['GET /proposals?status=history&status=bogus (first wins)', () => call('GET', '/proposals?status=history&status=bogus', RV)],
    ['GET /proposals?status=PEND\u0130NG (dotted capital I is not an ASCII i)', () => call('GET', '/proposals?status=PEND%C4%B0NG', RV)],
    ['GET /proposals?status[]=history', () => call('GET', '/proposals?status[]=history', RV)],
    // Against a row that exists on every stack: ids are different on each, so a fixed "0001" proved nothing.
    ['GET /proposals/000{id} of an existing row (leading zeros)', async () => { const row = await submit(); return row ? call('GET', '/proposals/000' + row.approvalId, RD) : { http: 0, code: 'NO-ROW' }; }],
    ['GET /proposals/+{id} of an existing row', async () => { const row = await submit(); return row ? call('GET', '/proposals/%2B' + row.approvalId, RD) : { http: 0, code: 'NO-ROW' }; }],
    ['GET /proposals/99999999999999999999', () => call('GET', '/proposals/99999999999999999999', RD)],
    ['GET /proposals/ (trailing slash)', () => call('GET', '/proposals/', RV)],
    ['GET /PROPOSALS (case)', () => call('GET', '/PROPOSALS', RV)],
    ['status=PENDING', () => call('GET', '/proposals?status=PENDING', RV)],
    ['status=bogus', () => call('GET', '/proposals?status=bogus', RV)],
    ['PUT /proposals', () => call('PUT', '/proposals', W, sub())],
    ['DELETE /proposals/1', () => call('DELETE', '/proposals/1', W)],
    ['key with a trailing space', () => call('POST', '/proposals', { ...W, [header(c.writeHeader)[0]]: header(c.writeHeader)[1] + ' ' }, sub())],
    ['key in upper case', () => call('POST', '/proposals', { ...W, [header(c.writeHeader)[0]]: header(c.writeHeader)[1].toUpperCase() }, sub())],
    ['body over 200,000 bytes', () => call('POST', '/proposals', W, sub({ reason: 'x'.repeat(200001) }))],
  ];
}

const configs = files.map((f) => buildConfig({ config: f }));
for (const c of configs) if (!isLocal(c.baseUrl)) { console.error('Refusing non-local target ' + c.baseUrl); process.exit(2); }

const columns = [];
for (const c of configs) {
  const list = cases(c);
  const col = [];
  for (const [name, run] of list) {
    let r;
    try { r = await run(); } catch (e) { r = { http: 'threw', code: e.message.slice(0, 60) }; }
    let shown = `${r.http} ${r.code}`;
    // Different profiles name the resource differently ("article" on one stack, "post" on another): compare the shape, not the name.
    shown = shown.split(JSON.stringify(c.resourceType).slice(1, -1)).join('TYPE');
    // For write cases only the guard is under test; a CMS that refuses the field afterwards (502) still means the guard passed.
    if (/^(write|delete action: write)/.test(name) && (/^200 ok/.test(shown) || /^502 WRITE_FAILED/.test(shown))) shown = '200|502 guard-passed';
    col.push([name, shown.replace(/[^\x20-\x7e]/g, (ch) => '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0'))]);
  }
  columns.push(col);
}

const names = files.map((f) => f.replace(/^.*\//, '').replace(/\.json$/, ''));
let differ = 0;
for (let i = 0; i < columns[0].length; i += 1) {
  const values = columns.map((col) => col[i][1]);
  const same = values.every((v) => v === values[0]);
  if (!same) differ += 1;
  console.log(`${same ? '   ' : '!! '}${columns[0][i][0]}`);
  values.forEach((v, j) => console.log(`      ${names[j].padEnd(18)} ${v}`));
}
console.log(`\n${columns[0].length} cases, ${differ} with disagreement`);
