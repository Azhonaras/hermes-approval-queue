/**
 * Hostile and awkward inputs. Every stack parses JSON a little differently; these checks pin the
 * strict behaviour in docs/spec.md ("Strict input") so the same bytes mean the same thing everywhere.
 */
import { expect, expectStatus, expectCode, expectOneOf, expectGuardPassed } from '../assert.mjs';

const first = (ctx) => Object.keys(ctx.submission().proposal)[0];
const json = (ctx, mutate) => {
  const body = ctx.submission();
  mutate(body);
  return JSON.stringify(body);
};

export default [
  {
    id: 'edge.size-counts-characters-not-escapes', level: 'must', title: 'Persian and <&> text is measured as typed, not as escaped bytes',
    async run(ctx) {
      const key = first(ctx);
      expectStatus(await ctx.call('write', 'POST', '/proposals', ctx.submission({ proposal: { [key]: 'ب'.repeat(8000) } })), 200, '8000 Persian characters');
      expectStatus(await ctx.call('write', 'POST', '/proposals', ctx.submission({ proposal: { [key]: '<&>'.repeat(2600) } })), 200, '7800 characters of <&>');
      expectStatus(await ctx.call('write', 'POST', '/proposals', ctx.submission({ proposal: { [key]: '🙂'.repeat(4000) } })), 200, '4000 emoji (8000 UTF-16 units)');
    }
  },
  {
    id: 'edge.size-boundary', level: 'must', title: 'The limit is exactly 16384 characters of compact JSON',
    async run(ctx) {
      const key = first(ctx);
      const overhead = JSON.stringify({ [key]: '' }).length;
      expectStatus(await ctx.call('write', 'POST', '/proposals', ctx.submission({ proposal: { [key]: 'a'.repeat(16384 - overhead) } })), 200, 'exactly 16384');
      expectStatus(await ctx.call('write', 'POST', '/proposals', ctx.submission({ proposal: { [key]: 'a'.repeat(16385 - overhead) } })), 400, '16385');
    }
  },
  {
    id: 'edge.duplicate-keys-refused', level: 'must', title: 'Duplicate JSON keys are refused (parsers disagree on which one wins)',
    async run(ctx) {
      const key = first(ctx);
      const dupProposal = json(ctx, () => {}).replace(/"proposal":\{/, `"proposal":{"${key}":"https://first.example/",`);
      expectCode(ctx, await ctx.call('write', 'POST', '/proposals', undefined, { rawBody: dupProposal }), 400, 'BAD_REQUEST', 'duplicate key inside proposal');
      const dupAction = json(ctx, () => {}).replace(/"action":"[^"]+"/, (m) => `${m},"action":"${ctx.config.deleteAction || 'delete:taxonomy'}"`);
      expectCode(ctx, await ctx.call('write', 'POST', '/proposals', undefined, { rawBody: dupAction }), 400, 'BAD_REQUEST', 'duplicate top-level action');
    }
  },
  {
    id: 'edge.invalid-unicode-refused', level: 'must', title: 'Unpaired surrogates and invalid UTF-8 are refused with 400',
    async run(ctx) {
      const key = first(ctx);
      const surrogate = json(ctx, () => {}).replace(/"proposal":\{"[^"]+":"[^"]*"/, `"proposal":{"${key}":"\\ud800"`);
      expectCode(ctx, await ctx.call('write', 'POST', '/proposals', undefined, { rawBody: surrogate }), 400, 'BAD_REQUEST', 'lone high surrogate');
      const lowFirst = json(ctx, () => {}).replace(/"proposal":\{"[^"]+":"[^"]*"/, `"proposal":{"${key}":"\\udc00x"`);
      expectCode(ctx, await ctx.call('write', 'POST', '/proposals', undefined, { rawBody: lowFirst }), 400, 'BAD_REQUEST', 'lone low surrogate');
      const bad = Buffer.concat([Buffer.from('{"a":"'), Buffer.from([0xff, 0xfe]), Buffer.from('"}')]);
      const r = await ctx.call('write', 'POST', '/proposals', undefined, { rawBody: bad });
      expect(r.http === 400, `invalid UTF-8 must be 400, got ${r.http}`);
      const paired = ctx.submission({ proposal: { [key]: 'ok 🙂' } });
      expectStatus(await ctx.call('write', 'POST', '/proposals', paired), 200, 'a valid surrogate pair (emoji) is fine');
    }
  },
  {
    id: 'edge.nesting-limit', level: 'must', title: 'JSON nested deeper than 32 levels is refused',
    async run(ctx) {
      const deep = (n) => '{"a":'.repeat(n) + '1' + '}'.repeat(n);
      const body = (n) => json(ctx, () => {}).replace(/"proposal":\{.*\}\}$/, `"proposal":${deep(n)}}`);
      expectStatus(await ctx.call('write', 'POST', '/proposals', undefined, { rawBody: body(100) }), 400, '100 levels');
      expectStatus(await ctx.call('write', 'POST', '/proposals', undefined, { rawBody: body(2000) }), 400, '2000 levels');
      expectStatus(await ctx.call('write', 'POST', '/proposals', undefined, { rawBody: body(30) }), 200, '30 levels is allowed');
    }
  },
  {
    id: 'edge.strict-types', level: 'must', title: 'Wrongly typed fields are 400, not coerced',
    async run(ctx) {
      const bad = [
        { siteId: '1' }, { siteId: 1.5 }, { siteId: 0 }, { siteId: -1 }, { siteId: 1000000000 }, { siteId: 2147483648 },
        { resourceId: { a: 1 } }, { resourceId: [1] }, { resourceId: true },
        { resourceType: 5 }, { action: 5 }, { scope: 5 }, { reason: 12 }, { revisionOfApprovalId: 'abc' }, { revisionOfApprovalId: 1.5 }
      ];
      for (const extra of bad) {
        const r = await ctx.call('write', 'POST', '/proposals', ctx.submission(extra));
        expect(r.http === 400, `${JSON.stringify(extra)} must be 400, got ${r.http}`);
      }
    }
  },
  {
    id: 'edge.ids-never-500', level: 'must', title: 'Absurd ids are 404/400, never a server error',
    async run(ctx) {
      expectStatus(await ctx.call('read', 'GET', '/proposals/99999999999999999999'), 404, 'huge id on GET');
      expectStatus(await ctx.decide('99999999999999999999', 'approve', {}), 404, 'huge id on approve');
      for (const approvalId of ['5', null, 1.5, [1], { a: 1 }, true]) {
        const r = await ctx.call('write', 'POST', '/writes', { approvalId, resourceType: 'x', resourceId: 1, action: ctx.config.action, scope: ctx.config.scope, proposal: {} });
        expect(r.http === 400, `approvalId ${JSON.stringify(approvalId)} must be 400, got ${r.http}`);
      }
      expectStatus(await ctx.call('write', 'POST', '/writes', { resourceType: 'x' }), 400, 'missing approvalId');
    }
  },
  {
    id: 'edge.identifier-length-limits', level: 'must', title: 'resourceType (100) and resourceId (200) have limits; longer is 400, never a database error',
    async run(ctx) {
      const post = (over) => ctx.call('write', 'POST', '/proposals', ctx.submission(over));
      expectStatus(await post({ resourceId: 'x'.repeat(198) }), 200, 'a 198-character id (200 with quotes)');
      expectStatus(await post({ resourceId: 'x'.repeat(199) }), 400, 'a 199-character id (201 with quotes)');
      expectStatus(await post({ resourceId: 'x'.repeat(5000) }), 400, 'a 5000-character id');
      expectStatus(await post({ resourceType: 't'.repeat(100) }), 200, 'a 100-character type');
      expectStatus(await post({ resourceType: 't'.repeat(101) }), 400, 'a 101-character type');
      expectStatus(await ctx.call('read', 'GET', `/resources/article/${'9'.repeat(5000)}`), 404, 'reading an absurdly long id');
    }
  },
  {
    id: 'edge.resource-id-type-bound', level: 'must', title: 'The id 42 and the id "42" are different resources for the guard',
    async run(ctx) {
      // The configured resource when its id is a number, so the exact write lands on something that exists.
      const id = typeof ctx.config.resourceId === 'number' ? ctx.config.resourceId : 42;
      const row = await ctx.approved({ resourceId: id });
      expectCode(ctx, await ctx.execute(row, { resourceId: String(id) }), 409, 'APPROVAL_MISMATCH', 'string id against number id');
      expectGuardPassed(ctx, await ctx.execute(row), 'the exact request still passes the guard');
    }
  },
  {
    id: 'edge.number-forms-equal', level: 'should', title: '1, 1.0 and 1e0 are the same number to the guard',
    async run(ctx) {
      const base = ctx.submission().proposal;
      const row = await ctx.approved({ proposal: { ...base, n: 1, price: 10.5 } });
      const raw = `{"approvalId":${row.approvalId},"resourceType":${JSON.stringify(row.resourceType)},"resourceId":${JSON.stringify(row.resourceId)},` +
        `"action":${JSON.stringify(row.action)},"scope":${JSON.stringify(row.scope)},"proposal":${JSON.stringify(row.proposal).replace('"n":1', '"n":1.0e0').replace('10.5', '1.05e1')}}`;
      expectGuardPassed(ctx, await ctx.call('write', 'POST', '/writes', undefined, { rawBody: raw }), 'equal numbers in other notation');
    }
  },
  {
    id: 'edge.proto-key-is-plain-data', level: 'must', title: 'A "__proto__" key is stored as ordinary data and pollutes nothing',
    async run(ctx) {
      const raw = json(ctx, () => {}).replace(/"proposal":\{/, '"proposal":{"__proto__":{"admin":true},');
      const r = await ctx.call('write', 'POST', '/proposals', undefined, { rawBody: raw });
      expectStatus(r, 200, '__proto__ key');
      const row = ctx.data(r);
      expect(JSON.stringify(row.proposal.__proto__) === '{"admin":true}' || Object.getOwnPropertyDescriptor(row.proposal, '__proto__'), '__proto__ must come back as data');
      const next = await ctx.submit();
      expect(next.admin === undefined && next.proposal.admin === undefined && ({}).admin === undefined, 'prototype was polluted');
    }
  },
  {
    id: 'edge.hostile-requests-never-5xx', level: 'must', title: 'A battery of malformed requests never produces a 5xx',
    async run(ctx) {
      const W = 'write'; const R = 'review';
      const cases = [
        [W, 'POST', '/proposals', undefined, '[]'], [W, 'POST', '/proposals', undefined, '"text"'], [W, 'POST', '/proposals', undefined, '123'],
        [W, 'POST', '/proposals', undefined, 'true'], [W, 'POST', '/proposals', undefined, '{'], [W, 'POST', '/proposals', undefined, '{"a":}'],
        [W, 'POST', '/proposals', undefined, '{"a":1}{"b":2}'], [W, 'POST', '/proposals', undefined, '\u0000\u0000'], [W, 'POST', '/proposals', undefined, 'NaN'],
        [W, 'POST', '/proposals', undefined, '{"a":1e999}'], [W, 'POST', '/proposals', undefined, '{"proposal":{"a":' + '9'.repeat(5000) + '}}'],
        [W, 'POST', '/writes', undefined, '{}'], [W, 'POST', '/writes', undefined, '[]'], [W, 'POST', '/writes', undefined, 'null'],
        [R, 'POST', '/proposals/1/approve', undefined, '[]'], [R, 'POST', '/proposals/1/approve', undefined, '{"reason":{"a":1}}'],
        [R, 'POST', '/proposals/1/approve', undefined, '{"proposal":"x"}'], [R, 'POST', '/proposals/1/approve', undefined, '{"proposal":[]}'],
        [R, 'POST', '/proposals/1/reject', undefined, '{"reason":12}'], [R, 'POST', '/proposals/0/approve', {}],
        [R, 'POST', '/proposals/-1/approve', {}], [R, 'POST', '/proposals/abc/approve', {}], [R, 'GET', '/proposals?status=' + 'x'.repeat(5000)],
        [R, 'GET', '/proposals?status=pending&status=history'], [R, 'GET', '/proposals?status[]=pending'], [W, 'GET', '/proposals/1%00'],
        [W, 'GET', '/proposals/' + '9'.repeat(400)], [W, 'GET', '/resources/%00/%00'], [W, 'GET', '/resources//'], [W, 'GET', '/resources/a/b/c'],
        [W, 'DELETE', '/proposals/1'], [W, 'PATCH', '/proposals/1'], [W, 'PUT', '/writes', {}], ['none', 'GET', '/' + 'a'.repeat(3000)],
        ['none', 'GET', '/%ff%fe'], ['none', 'GET', '/..%2f..%2f'], [W, 'POST', '/proposals/1/approve', {}], [W, 'GET', '/resources/article/' + encodeURIComponent('é'.repeat(300))]
      ];
      const failures = [];
      for (const [who, method, path, body, rawBody] of cases) {
        const r = await ctx.call(who, method, path, body, rawBody === undefined ? {} : { rawBody });
        if (r.http >= 500 || r.http === 0) failures.push(`${method} ${path.slice(0, 40)} ${rawBody ? String(rawBody).slice(0, 20) : ''} -> ${r.http}`);
      }
      expect(!failures.length, failures.length + ' request(s) gave a 5xx: ' + failures.slice(0, 4).join(' | '));
    }
  },
  {
    id: 'edge.no-trace-on-errors', level: 'should', title: 'Server errors never include stack traces',
    async run(ctx) {
      const r = await ctx.call('write', 'POST', '/proposals', undefined, { rawBody: '{"x":' });
      expect(!/\bat [\w.<>$]+\(|System\.|Microsoft\.|node:internal|Traceback|vendor\/|\.php on line/.test(r.text), 'error response leaks internals: ' + r.text.slice(0, 120));
    }
  },
  {
    id: 'edge.nesting-boundary', level: 'must', title: 'Exactly 32 nested containers are fine; the 33rd is refused (the body object counts as the first)',
    async run(ctx) {
      // The body is level 1, the proposal object level 2, then n arrays inside it.
      const body = (n, innermost) => json(ctx, () => {}).replace(/"proposal":\{.*\}\}$/, `"proposal":{"a":${'['.repeat(n)}${innermost}${']'.repeat(n)}}}`);
      expectStatus(await ctx.call('write', 'POST', '/proposals', undefined, { rawBody: body(30, '1') }), 200, '32 levels in total');
      expectStatus(await ctx.call('write', 'POST', '/proposals', undefined, { rawBody: body(31, '1') }), 400, '33 levels in total');
      expectStatus(await ctx.call('write', 'POST', '/proposals', undefined, { rawBody: body(30, '[]') }), 400, '33 levels, innermost array empty');
    }
  },
  {
    id: 'edge.numbers-are-doubles', level: 'must', title: 'Numbers are IEEE doubles: integers beyond 2^53-1 and non-finite numbers are refused, -0 is 0',
    async run(ctx) {
      const withNumbers = (literal) => json(ctx, () => {}).replace(/"proposal":\{/, `"proposal":{"n":${literal},`);
      const post = (literal) => ctx.call('write', 'POST', '/proposals', undefined, { rawBody: withNumbers(literal) });
      expectStatus(await post('9007199254740991'), 200, '2^53-1');
      expectStatus(await post('-9007199254740991'), 200, '-(2^53-1)');
      for (const bad of ['9007199254740992', '-9007199254740992', '12345678901234567890', '1e999', '-1e999']) {
        expectCode(ctx, await post(bad), 400, 'BAD_REQUEST', `number ${bad}`);
      }
      const ok = await post('[-0, 0.1, 1e21, 1e-7, 1.5e300, 1E2, 10.0]');
      expectStatus(ok, 200, 'a list of ordinary numbers');
      const got = ctx.data(ok).proposal.n;
      const want = [0, 0.1, 1e21, 1e-7, 1.5e300, 100, 10];
      expect(want.every((v, i) => got[i] === v), `numbers came back as ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
    }
  },
  {
    id: 'edge.decision-input-strict', level: 'must', title: 'A decision with a wrongly typed or oversized reason, or a malformed body, is 400 and decides nothing',
    async run(ctx) {
      const row = await ctx.submit();
      const attempts = [
        ['approve', { reason: 5 }], ['approve', { reason: { a: 1 } }], ['approve', { reason: ['x'] }], ['approve', { reason: true }],
        ['approve', { reason: 'r'.repeat(1025) }], ['reject', { reason: 'r'.repeat(1025) }], ['reject', { reason: 12 }],
        ['approve', { reason: '', proposal: null }], ['approve', { reason: '', proposal: [] }], ['approve', { reason: '', proposal: 'x' }],
        ['request-changes', { reason: 'x', proposal: ctx.submission().proposal }]
      ];
      for (const [verb, body] of attempts) {
        const r = await ctx.decide(row.approvalId, verb, body);
        expect(r.http === 400, `${verb} ${JSON.stringify(body).slice(0, 60)} must be 400, got ${r.http}`);
      }
      for (const raw of ['[]', 'null', '"text"', '12', 'true']) {
        const r = await ctx.call('review', 'POST', `/proposals/${row.approvalId}/approve`, undefined, { rawBody: raw });
        expect(r.http === 400, `approve with body ${raw} must be 400, got ${r.http}`);
      }
      expectCode(ctx, await ctx.decide(row.approvalId, 'reject', { reason: '   ' }), 400, 'DECISION_REASON_REQUIRED', 'blank reason');
      const polled = ctx.data(await ctx.call('read', 'GET', `/proposals/${row.approvalId}`));
      expect(polled.status === 'Pending', `after every refused decision the row must still be Pending, is ${polled.status}`);
      expectStatus(await ctx.decide(row.approvalId, 'approve', { reason: 'r'.repeat(1024) }), 200, 'a 1024-character reason is allowed');
    }
  },
  {
    id: 'edge.write-body-types', level: 'must', title: 'A write whose fields have the wrong type is refused by the guard (409/400), never a server error',
    async run(ctx) {
      const row = await ctx.approved();
      const wrong = [
        { resourceType: 5 }, { resourceType: null }, { resourceType: ['x'] }, { action: 5 }, { action: null }, { scope: ['seo:write'] },
        { resourceId: null }, { resourceId: String(row.resourceId) }, { resourceId: [row.resourceId] },
        { siteId: 2 }, { siteId: null }, { siteId: '1' }, { siteId: 1.5 }, { siteId: [1] },
        { proposal: false }, { proposal: 0 }, { proposal: 'x' }, { proposal: [] }
      ];
      for (const extra of wrong) {
        const r = await ctx.execute(row, extra);
        expect(r.http === 409 || r.http === 400, `write with ${JSON.stringify(extra)} must be 409 or 400, got ${r.http}`);
      }
      for (const approvalId of ['5', null, 1.5, [1], { a: 1 }, true, -1, 0]) {
        const r = await ctx.execute(row, { approvalId });
        expect(r.http >= 400 && r.http < 500, `approvalId ${JSON.stringify(approvalId)} must be a 4xx, got ${r.http}`);
      }
      // None of the refusals used the approval up, and a body that repeats the row's own siteId is the same request.
      const same = await ctx.execute(row, { siteId: row.siteId });
      expect(same.http === 200 || (same.http === 502 && ctx.code(same) === 'WRITE_FAILED'), `the exact request, with its own siteId, must pass the guard, got ${same.http} ${same.text.slice(0, 120)}`);
    }
  },
  {
    id: 'edge.path-rules', level: 'must', title: 'Path segments are percent-decoded once; 007, +7 and 7.0 are strings, not the number 7',
    async run(ctx) {
      const id = ctx.config.resourceId;
      if (!Number.isInteger(id) || id <= 0) return 'skipped (the profile resourceId is not a positive integer)';
      const type = encodeURIComponent(ctx.config.resourceType);
      const get = (segment) => ctx.call('read', 'GET', `/resources/${type}/${segment}`);
      const plain = await get(String(id));
      expectStatus(plain, 200, 'the plain id (baseline; the resource must exist)');
      const encoded = [...String(id)].map((ch) => '%' + ch.charCodeAt(0).toString(16)).join('');
      const viaEscapes = await get(encoded);
      expectStatus(viaEscapes, 200, 'the same id written as %-escapes');
      expect(JSON.stringify(viaEscapes.json.data) === JSON.stringify(plain.json.data), 'escaped and plain id must return the same resource');
      expectStatus(await get('0' + id), 404, 'leading zero (a string, not the number)');
      expectStatus(await get('+' + id), 404, 'plus sign');
      expectStatus(await get(id + '.0'), 404, 'decimal form');
      expectStatus(await get(encoded.replaceAll('%', '%25')), 404, 'double-encoded (must be decoded once, not twice)');
      // A trailing newline once slipped through "$" in .NET and PCRE, which match before a final newline: "42\n" read as 42.
      expectStatus(await get(id + '%0A'), 404, 'a number followed by a newline is a string, not the number');
      expectStatus(await get('%0A' + id), 404, 'a newline before the number');
      expectStatus(await get(id + '%20'), 404, 'a trailing space');
      const nul = await get(id + '%00');
      expect(nul.http === 400 || nul.http === 404, `a NUL (%00) in the path must be refused with 400 (a server in front may answer 404), got ${nul.http}`);
      expectStatus(await get('%zz'), 400, 'malformed escape');
      expectStatus(await get('%'), 400, 'lone percent sign');
      expectStatus(await get('%FF'), 400, 'bytes that are not UTF-8');
      const slash = await get(String(id).slice(0, 1) + '%2F' + String(id).slice(1));
      expect(slash.http >= 400 && slash.http < 500, `an encoded slash stays inside the segment (4xx), got ${slash.http}`);
    }
  },
  {
    id: 'edge.content-type', level: 'must', title: 'A JSON body needs Content-Type: application/json (415 otherwise); parameters and case do not matter',
    async run(ctx) {
      const refused = []; // every body sent with a wrong type carries its own reason, so a stored row can be recognised
      const post = (type, refusedType) => {
        const body = ctx.submission();
        if (refusedType) refused.push(body.reason);
        return ctx.callRaw('write', 'POST', '/proposals', { body: JSON.stringify(body), extraHeaders: type === null ? {} : { 'Content-Type': type } });
      };
      for (const type of ['application/json', 'APPLICATION/JSON', 'application/json; charset=utf-8', 'application/json;charset=UTF-8']) {
        expectStatus(await post(type, false), 200, `Content-Type ${type}`);
      }
      for (const type of ['text/plain', 'text/plain; charset=utf-8', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', 'application/vnd.api+json', '']) {
        expectCode(ctx, await post(type, true), 415, 'UNSUPPORTED_MEDIA_TYPE', `Content-Type ${JSON.stringify(type)}`);
      }
      expectCode(ctx, await post(null, true), 415, 'UNSUPPORTED_MEDIA_TYPE', 'a body with no Content-Type at all');
      // No Content-Type and no body is "{}" (docs/spec.md, Strict input), not an unsupported media type: it is then refused for what it lacks.
      expectCode(ctx, await ctx.callRaw('write', 'POST', '/proposals'), 400, 'BAD_REQUEST', 'no body and no Content-Type at all');
      // Refusing the type must not have created a row.
      const text = JSON.stringify((await ctx.call('review', 'GET', '/proposals?status=pending')).json);
      const stored = refused.filter((reason) => text.includes(reason));
      expect(!stored.length, `${stored.length} request(s) refused for their Content-Type were stored anyway`);
    }
  },
  {
    id: 'edge.query-names-are-exact', level: 'must', title: 'Query parameter names are matched exactly: SITEID is not siteId, and ";" is not a separator',
    async run(ctx) {
      const resource = `/resources/${encodeURIComponent(ctx.config.resourceType)}/${encodeURIComponent(ctx.config.resourceId)}`;
      // A differently cased name is another parameter and is ignored, so a value that siteId itself would refuse is fine there.
      if (ctx.config.siteId === 1) {
        for (const q of ['?SITEID=abc', '?SiteId=0', '?siteid=-1']) expectStatus(await ctx.call('read', 'GET', resource + q), 200, `${q} is not siteId`);
      }
      expectStatus(await ctx.call('read', 'GET', resource + '?siteId=1;siteId=2'), 400, '";" does not split parameters, so the value is "1;siteId=2"');
      expectStatus(await ctx.call('review', 'GET', '/proposals?STATUS=nonsense'), 200, '?STATUS= is not status');
      expectStatus(await ctx.call('review', 'GET', '/proposals?status=nonsense'), 400, '?status=nonsense');
      expectStatus(await ctx.call('review', 'GET', '/proposals?status=pending;status=history'), 400, 'status with a ";" in its value');
    }
  },
  {
    id: 'edge.api-key-header-spacing', level: 'must', title: 'Spaces and tabs around the agent key in its header are not part of the key',
    async run(ctx) {
      const line = ctx.config.writeHeader;
      const cut = line.indexOf(':');
      const name = line.slice(0, cut).trim();
      const value = line.slice(cut + 1).trim();
      const send = (headers) => ctx.callRaw('none', 'POST', '/proposals', { body: JSON.stringify(ctx.submission()), extraHeaders: { 'Content-Type': 'application/json', ...headers } });
      expectStatus(await send({ [name]: value }), 200, `${name} as configured`);
      expectStatus(await send({ [name]: `  ${value}\t` }), 200, `${name} with spaces and a tab around the value`);
      expectOneOf(await send({ [name]: value + 'x' }), [401, 403], `${name} with one wrong character`);
    }
  },
  {
    id: 'edge.api-key-header-name', level: 'should', title: 'The agent key is read by its header name only: X_Api_Key is not X-Api-Key',
    async run(ctx) {
      // PHP behind most SAPIs (FPM, CGI, WordPress Playground) turns both names into the same $_SERVER variable and cannot tell
      // them apart, and nginx drops underscore headers by default, so this is a warning, not a failure. Where the platform can
      // tell them apart (mod_php, PHP's built-in server, Node, .NET) it must.
      const line = ctx.config.writeHeader;
      const cut = line.indexOf(':');
      const name = line.slice(0, cut).trim();
      const value = line.slice(cut + 1).trim();
      if (!name.includes('-')) return;
      const folded = name.replaceAll('-', '_');
      const r = await ctx.callRaw('none', 'POST', '/proposals', { body: JSON.stringify(ctx.submission()), extraHeaders: { 'Content-Type': 'application/json', [folded]: value } });
      expect(r.http === 401 || r.http === 403, `${folded} (underscores) was read as ${name}: HTTP ${r.http}. Header names with underscores should be refused; a PHP SAPI that folds them cannot tell, and the key is still required`);
    }
  },
  {
    id: 'edge.paths-are-not-normalized', level: 'should', title: 'The router matches the path exactly as sent: "..", "%2e%2e" and "\\" are not resolved',
    async run(ctx) {
      // /ping answers 200 without credentials, so a path that was normalized onto it would give 200 instead of 404.
      // A web server in front (Apache, nginx, IIS) may normalize before the application runs; then this warning is not the application's doing.
      const reached = [];
      for (const path of ['/proposals/../ping', '/proposals/%2e%2e/ping', '/proposals/%2E%2E/ping', '/./ping', '\\ping', '/proposals\\..\\ping']) {
        const r = await ctx.callRaw('none', 'GET', path);
        if (r.http === 200) reached.push(path);
        else expect(r.http === 404 || r.http === 400, `${path} must be 404 or 400, got ${r.http}`);
      }
      expect(!reached.length, `these paths were normalized onto /ping: ${reached.join(' ')}. A path rule in a proxy or WAF that does not see the normalized form could be bypassed`);
    }
  },
  {
    id: 'edge.query-rules', level: 'must', title: 'Query strings: siteId must be a positive integer, the first repeated value wins, status ignores ASCII case only',
    async run(ctx) {
      const id = ctx.config.resourceId;
      const res = (q) => ctx.call('read', 'GET', `/resources/${encodeURIComponent(ctx.config.resourceType)}/${encodeURIComponent(id)}${q}`);
      const bads = ['?siteId=abc', '?siteId=0', '?siteId=-1', '?siteId=01', '?siteId=1.5', '?siteId=', '?siteId=9999999999',
        '?siteId=1%0A', '?siteId=%0A1', '?siteId=1%20', '?siteId=%201', '?siteId=%EF%BC%91' /* full-width 1 */];
      for (const bad of bads) {
        const r = await res(bad);
        expect(r.http === 400, `${bad} must be 400, got ${r.http}`);
      }
      if (ctx.config.siteId === 1) {
        expectStatus(await res('?siteId=1&siteId=2'), 200, 'first siteId wins (1)');
        expectStatus(await res('?siteId=%31'), 200, 'percent-encoded siteId');
        expectStatus(await res('?siteId[]=2'), 200, 'siteId[] is a different parameter and is ignored');
      }
      expectStatus(await res('?siteId=2&siteId=1'), 404, 'first siteId wins (2: no such site)');
      const list = (q) => ctx.call('review', 'GET', '/proposals' + q);
      expectStatus(await list('?status='), 200, 'empty status means pending');
      expectStatus(await list('?status=PENDING'), 200, 'ASCII upper case');
      expectStatus(await list('?status=history&status=bogus'), 200, 'first status wins');
      expectStatus(await list('?status=bogus&status=history'), 400, 'first status wins (bogus)');
      expectStatus(await list('?status[]=history'), 200, 'status[] is ignored');
      expectStatus(await list('?status=PEND%C4%B0NG'), 400, 'a dotted capital I is not an i');
    }
  },
  {
    id: 'edge.trim-matches-javascript', level: 'must', title: 'resourceType is trimmed like JavaScript: BOM and no-break space go, U+0085 stays',
    async run(ctx) {
      const type = ctx.config.resourceType;
      const post = (resourceType) => ctx.call('write', 'POST', '/proposals', ctx.submission({ resourceType }));
      const wrapped = await post('﻿' + type + '  　');
      expectStatus(wrapped, 200, 'BOM and Unicode spaces around the type');
      expect(ctx.data(wrapped).resourceType === type, `stored type is ${JSON.stringify(ctx.data(wrapped).resourceType)}, expected ${JSON.stringify(type)}`);
      const nel = await post('\u0085' + type);
      if (nel.http === 200) expect(ctx.data(nel).resourceType === '\u0085' + type, 'U+0085 (next line) is not whitespace to JavaScript and must be kept');
      else expect(nel.http === 400, `U+0085 prefix must be kept or refused (400), got ${nel.http}`);
      expectStatus(await post('﻿  '), 400, 'a type that is only whitespace');
    }
  }
];
