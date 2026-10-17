/** Who may call what. The most important group: it proves the agent cannot approve itself. */
import { expect, expectStatus, expectCode, expectOneOf } from '../assert.mjs';

/**
 * nginx and Apache refuse a malformed percent-escape with their own 400 before any application runs (WordPress, Symfony, Rails
 * and so on never see it). That is not the CMS looking at the input before the door: it happens for every caller and every
 * URL. It counts as such only when the same escape gets the same non-CMS 400 outside the CMS's URL space, where no CMS route
 * can have answered. A CMS that is mounted at the root of its host cannot be told apart from its web server, so it gets no excuse.
 */
async function refusesBrokenEscapesEverywhere(ctx) {
  const outside = await ctx.callOutside('GET', '/%zz');
  return outside !== null && outside.http === 400 && !(outside.json && outside.json.error);
}

export default [
  {
    id: 'doors.ping-open', level: 'must', title: 'GET /ping answers without credentials',
    async run(ctx) {
      const r = await ctx.call('none', 'GET', '/ping');
      expectStatus(r, 200, 'ping');
      expect(r.json && r.json.success === true, 'ping must use the { success: true, data } envelope');
    }
  },
  {
    id: 'doors.manifest-needs-key', level: 'must', title: 'GET /manifest needs a read key',
    async run(ctx) {
      expectOneOf(await ctx.call('none', 'GET', '/manifest'), [401, 403], 'manifest without credentials');
      expectStatus(await ctx.call('read', 'GET', '/manifest'), 200, 'manifest with read key');
    }
  },
  {
    id: 'doors.error-envelope', level: 'must', title: 'Errors use { success:false, error:{ code, message } }',
    async run(ctx) {
      const r = await ctx.call('read', 'GET', '/proposals/999999999');
      expectStatus(r, 404, 'unknown proposal');
      expect(r.json && r.json.success === false && typeof r.json.error?.code === 'string' && typeof r.json.error?.message === 'string',
        'error body must be { success:false, error:{ code, message } }');
      expect(r.json.error.code === 'NOT_FOUND', 'unknown id must be NOT_FOUND, got ' + r.json.error.code);
    }
  },
  {
    id: 'doors.no-key-cannot-submit', level: 'must', title: 'No credentials cannot submit',
    async run(ctx) {
      expectOneOf(await ctx.call('none', 'POST', '/proposals', ctx.submission()), [401, 403], 'submit without credentials');
    }
  },
  {
    id: 'doors.read-key-cannot-submit', level: 'must', title: 'Read key cannot submit',
    async run(ctx) {
      expectCode(ctx, await ctx.call('read', 'POST', '/proposals', ctx.submission()), 403, 'SCOPE_DENIED', 'submit with read key');
    }
  },
  {
    id: 'doors.read-key-cannot-write', level: 'must', title: 'Read key cannot execute a write',
    async run(ctx) {
      const row = await ctx.approved();
      expectOneOf(await ctx.call('read', 'POST', '/writes', ctx.writeBody(row)), [401, 403], 'write with read key');
    }
  },
  {
    id: 'doors.write-key-cannot-approve', level: 'must', title: 'Write key cannot approve, reject or request changes',
    async run(ctx) {
      const row = await ctx.submit();
      for (const verb of ['approve', 'reject', 'request-changes']) {
        const r = await ctx.call('write', 'POST', `/proposals/${row.approvalId}/${verb}`, { reason: 'x' });
        expectOneOf(r, [401, 403], `${verb} with write key`);
      }
      const after = ctx.data(await ctx.call('read', 'GET', '/proposals/' + row.approvalId));
      expect(after.status === 'Pending', 'row must still be Pending, is ' + after.status);
    }
  },
  {
    id: 'doors.write-plus-review-cannot-approve', level: 'must', title: 'Sending the write key together with a review session still cannot approve',
    async run(ctx) {
      const row = await ctx.submit();
      const r = await ctx.call('writeAndReview', 'POST', `/proposals/${row.approvalId}/approve`, {});
      expectOneOf(r, [401, 403], 'approve with write key + review session');
    }
  },
  {
    id: 'doors.no-credentials-cannot-approve', level: 'must', title: 'No credentials cannot approve',
    async run(ctx) {
      const row = await ctx.submit();
      expectOneOf(await ctx.call('none', 'POST', `/proposals/${row.approvalId}/approve`, {}), [401, 403], 'approve without credentials');
      expectOneOf(await ctx.call('read', 'POST', `/proposals/${row.approvalId}/approve`, {}), [401, 403], 'approve with read key');
    }
  },
  {
    id: 'doors.review-cannot-submit-or-write', level: 'must', title: 'Review session cannot submit or execute a write',
    async run(ctx) {
      expectOneOf(await ctx.call('review', 'POST', '/proposals', ctx.submission()), [401, 403], 'submit with review session');
      const row = await ctx.approved();
      expectOneOf(await ctx.call('review', 'POST', '/writes', ctx.writeBody(row)), [401, 403], 'write with review session');
    }
  },
  {
    id: 'doors.queue-is-review-only', level: 'must', title: 'Listing the queue needs the review session',
    async run(ctx) {
      expectOneOf(await ctx.call('write', 'GET', '/proposals?status=pending'), [401, 403], 'list with write key');
      expectOneOf(await ctx.call('none', 'GET', '/proposals?status=pending'), [401, 403], 'list without credentials');
      expectStatus(await ctx.call('review', 'GET', '/proposals?status=pending'), 200, 'list with review session');
    }
  },
  {
    id: 'doors.door-comes-first', level: 'must', title: 'The door answers before the input is looked at: a caller who may not do this learns nothing about its body, path or query',
    async run(ctx) {
      const json = { 'Content-Type': 'application/json' };
      const text = { 'Content-Type': 'text/plain' };
      // [who, method, path, options]: each is wrong in two ways at once (not allowed AND malformed), so the status shows which check ran first.
      const cases = [
        ['none', 'POST', '/proposals', { body: '{', extraHeaders: json }],
        ['none', 'POST', '/proposals', { body: '{}', extraHeaders: text }],
        ['read', 'POST', '/proposals', { body: '[1,2', extraHeaders: json }],
        ['review', 'POST', '/proposals', { body: '{"a":1,"a":2}', extraHeaders: json }],
        ['review', 'POST', '/writes', { body: '{', extraHeaders: json }],
        ['read', 'POST', '/writes', { body: '{}', extraHeaders: text }],
        ['none', 'POST', '/proposals/1/approve', { body: '{', extraHeaders: json }],
        ['write', 'POST', '/proposals/1/approve', { body: '{', extraHeaders: json }],
        ['write', 'POST', '/proposals/99999999999999999999/reject', { body: '{"reason":5}', extraHeaders: json }],
        ['read', 'POST', '/proposals/1/approve', { body: '{', extraHeaders: text }],
        ['none', 'GET', '/proposals/1'],
        ['none', 'GET', '/proposals?status=nonsense'],
        ['write', 'GET', '/proposals?status=nonsense'],
        ['none', 'GET', `/resources/${ctx.config.resourceType}/%zz`],
        ['none', 'GET', `/resources/${ctx.config.resourceType}/${ctx.config.resourceId}?siteId=abc`]
      ];
      const wrong = [];
      const byWebServer = [];
      let webServerRefusesBrokenEscapes; // asked once, and only if a malformed escape was answered with a 400
      for (const [who, method, path, options] of cases) {
        const r = await ctx.callRaw(who, method, path, options);
        if (r.http === 401 || r.http === 403) continue;
        if (r.http === 400 && path.includes('%zz')) {
          webServerRefusesBrokenEscapes ??= await refusesBrokenEscapesEverywhere(ctx);
          if (webServerRefusesBrokenEscapes) { byWebServer.push(`${who} ${method} ${path}`); continue; }
        }
        wrong.push(`${who} ${method} ${path} -> ${r.http}`);
      }
      expect(!wrong.length, `these answered the input instead of the door (want 401 or 403): ${wrong.join('; ')}`);
      if (byWebServer.length) {
        return `note: the web server in front of the CMS answered 400 to a malformed % escape before the CMS was reached (${byWebServer.join('; ')}); ` +
          'it does so for every URL and every caller, so it tells nobody anything about the CMS';
      }
    }
  },
  {
    id: 'doors.agent-can-poll', level: 'must', title: 'Agent can poll its own proposal with the read or write key',
    async run(ctx) {
      const row = await ctx.submit();
      for (const who of ['read', 'write']) {
        const r = await ctx.call(who, 'GET', '/proposals/' + row.approvalId);
        expectStatus(r, 200, `poll with ${who} key`);
        expect(ctx.data(r).approvalId === row.approvalId, 'poll returned a different row');
      }
      expectOneOf(await ctx.call('none', 'GET', '/proposals/' + row.approvalId), [401, 403], 'poll without credentials');
    }
  }
];
