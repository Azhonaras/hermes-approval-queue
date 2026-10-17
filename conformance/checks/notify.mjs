/**
 * Decision notifications (docs/spec.md, "Decision notifications"). An optional feature, so this group runs only when the
 * profile has `notify: { port, secret }` and the CMS under test is set up to send its notifications to
 * http://<this machine>:<port>/ (any path), signed with that secret when there is one. The suite listens there itself
 * (conformance/receiver.mjs) and can make that receiver fail, hang, redirect or disappear.
 */
import { createHmac } from 'node:crypto';
import { expect, expectStatus } from '../assert.mjs';

const SKIP = 'skipped (add notify: {"port": ..., "secret": ...} to the profile and point the CMS\'s decision notifications at it)';
const WAIT_HINT = 'no notification reached the suite\'s receiver within 5 s. Is the CMS configured to send to this machine on the notify port?';

const VERBS = [
  { verb: 'approve', status: 'Approved', body: { reason: '' } },
  { verb: 'reject', status: 'Rejected', body: { reason: 'notify check' } },
  { verb: 'request-changes', status: 'ChangesRequested', body: { reason: 'notify check' } }
];

/** Submits, decides and waits for the notification. Returns the row the decision answered with. */
async function decideAndWait(ctx, verb, body, submitExtra) {
  const row = await ctx.submit(submitExtra);
  const res = await ctx.decide(row.approvalId, verb, body);
  expectStatus(res, 200, verb);
  const got = await ctx.receiver.waitFor(row.approvalId, 1);
  return { row, decided: ctx.data(res), got };
}

/** Runs `fn` with the receiver in `mode` and puts it back afterwards, so one check can never break the next. */
async function withReceiverMode(ctx, mode, fn) {
  const r = ctx.receiver;
  try {
    if (mode === 'down') await r.down(); else r.setMode(mode);
    return await fn();
  } finally {
    await r.up();
    r.setMode('ok');
  }
}

export default [
  {
    id: 'notify.decision-is-announced', level: 'must', title: 'A stored decision is announced once, with exactly the four documented fields',
    async run(ctx) {
      if (!ctx.receiver) return SKIP;
      const seen = new Set();
      for (const { verb, status, body } of VERBS) {
        const { row, decided, got } = await decideAndWait(ctx, verb, body);
        expect(got.length >= 1, verb + ': ' + WAIT_HINT);
        const all = await ctx.receiver.quiet(row.approvalId, 400);
        expect(all.length === 1, `${verb}: expected exactly one notification, got ${all.length}`);
        const d = all[0];
        const want = `{"event":"decision","approvalId":${row.approvalId},"status":"${status}","decidedUtc":${JSON.stringify(decided.decidedUtc)}}`;
        expect(d.method === 'POST', `${verb}: the notification must be a POST, was ${d.method}`);
        expect(/^application\/json\b/i.test(d.headers['content-type'] || ''), `${verb}: Content-Type must be application/json, was ${d.headers['content-type']}`);
        expect(d.body === want, `${verb}: the body must be exactly ${want}, got ${d.body.slice(0, 300)}`);
        const delivery = d.headers['x-hermes-delivery'];
        expect(typeof delivery === 'string' && delivery.length >= 8, `${verb}: X-Hermes-Delivery is missing or too short`);
        expect(!seen.has(delivery), `${verb}: X-Hermes-Delivery repeats an earlier delivery; it must be unique`);
        seen.add(delivery);
      }
    }
  },
  {
    id: 'notify.nudge-carries-no-content', level: 'must', title: 'A notification never carries the proposal, the agent\'s reason, the reviewer\'s note or an edit',
    async run(ctx) {
      if (!ctx.receiver) return SKIP;
      const marker = 'marker-' + ctx.unique();
      const row = await ctx.submit({ reason: 'why ' + marker });
      const field = Object.keys(row.proposal)[0];
      const looksLikeUrl = typeof row.proposal[field] === 'string' && /^https?:\/\//.test(row.proposal[field]);
      const edited = { ...row.proposal, [field]: (looksLikeUrl ? 'https://example.com/edit-' : 'edit-') + marker };
      let res = await ctx.decide(row.approvalId, 'approve', { reason: 'note ' + marker, proposal: edited });
      if (res.http === 400 || res.http === 404 || res.http === 405) res = await ctx.decide(row.approvalId, 'approve', { reason: 'note ' + marker }); // no edit extension
      expectStatus(res, 200, 'approve');
      const got = await ctx.receiver.waitFor(row.approvalId, 1);
      expect(got.length >= 1, WAIT_HINT);
      const text = got[0].body;
      let parsed = null;
      try { parsed = JSON.parse(text); } catch { /* reported below */ }
      expect(parsed && typeof parsed === 'object' && !Array.isArray(parsed), 'the body is not a JSON object: ' + text.slice(0, 200));
      expect(Object.keys(parsed).join(',') === 'event,approvalId,status,decidedUtc', 'the body may only have event, approvalId, status and decidedUtc, it has: ' + Object.keys(parsed).join(', '));
      const original = JSON.stringify(row.proposal[field]).slice(1, -1);
      for (const [what, secret] of [['the reviewer\'s note, the reason or the edit', marker], ['the agent\'s original value', original]]) {
        expect(!text.includes(secret), `the notification leaks ${what}`);
      }
    }
  },
  {
    id: 'notify.signature-verifies', level: 'must', title: 'With a secret, X-Hermes-Timestamp and X-Hermes-Signature verify over the raw body',
    async run(ctx) {
      if (!ctx.receiver) return SKIP;
      const secret = ctx.config.notify.secret;
      if (!secret) return 'skipped (no notify.secret in the profile: the CMS is expected to send unsigned notifications)';
      const { got } = await decideAndWait(ctx, 'approve', { reason: '' });
      expect(got.length >= 1, WAIT_HINT);
      const d = got[0];
      const timestamp = d.headers['x-hermes-timestamp'];
      const given = d.headers['x-hermes-signature'];
      expect(/^\d{9,12}$/.test(timestamp || ''), 'X-Hermes-Timestamp must be unix seconds, got ' + JSON.stringify(timestamp));
      expect(Math.abs(Date.now() / 1000 - Number(timestamp)) <= 300, 'X-Hermes-Timestamp is more than five minutes away from this clock');
      expect(/^sha256=[0-9a-f]{64}$/.test(given || ''), 'X-Hermes-Signature must be "sha256=" and 64 lowercase hex digits, got ' + JSON.stringify(given));
      const want = 'sha256=' + createHmac('sha256', secret).update(timestamp + '.' + d.body).digest('hex');
      expect(given === want, 'X-Hermes-Signature is not HMAC-SHA256 of "<X-Hermes-Timestamp>.<raw body>" with the profile\'s secret');
    }
  },
  {
    id: 'notify.only-for-stored-decisions', level: 'must', title: 'Nothing is announced for a submit, a refused decision, a repeated decision or a write',
    async run(ctx) {
      if (!ctx.receiver) return SKIP;
      const row = await ctx.submit();
      const refused = [
        ['reject without a reason', await ctx.decide(row.approvalId, 'reject', { reason: '' })],
        ['request-changes without a reason', await ctx.decide(row.approvalId, 'request-changes', {})],
        ['approve with the agent\'s key', await ctx.call('write', 'POST', '/proposals/' + row.approvalId + '/approve', { reason: '' })],
        ['approve with no credentials', await ctx.call('none', 'POST', '/proposals/' + row.approvalId + '/approve', { reason: '' })]
      ];
      for (const [what, res] of refused) expect(res.http >= 400 && res.http < 500, `precondition: ${what} should be refused with a 4xx, got ${res.http}`);
      const early = await ctx.receiver.quiet(row.approvalId, 500);
      expect(early.length === 0, `a submit and ${refused.length} refused decisions produced ${early.length} notification(s); only a stored decision may`);

      expectStatus(await ctx.decide(row.approvalId, 'approve', { reason: '' }), 200, 'approve');
      const first = await ctx.receiver.waitFor(row.approvalId, 1);
      expect(first.length === 1, WAIT_HINT);

      const again = [
        ['approve again', await ctx.decide(row.approvalId, 'approve', { reason: '' })],
        ['reject after approve', await ctx.decide(row.approvalId, 'reject', { reason: 'late' })]
      ];
      for (const [what, res] of again) expect(res.http === 409, `precondition: ${what} should be 409, got ${res.http}`);
      expectStatus(await ctx.execute(row), 200, 'write');
      const all = await ctx.receiver.quiet(row.approvalId, 500);
      expect(all.length === 1, `after repeated decisions and a write there must still be exactly one notification, got ${all.length}`);
    }
  },
  {
    id: 'notify.receiver-failure-is-harmless', level: 'must', title: 'A receiver that answers 500, never answers or is down never changes a decision or the write after it',
    async run(ctx) {
      if (!ctx.receiver) return SKIP;
      for (const mode of ['error', 'hang', 'down']) {
        await withReceiverMode(ctx, mode, async () => {
          const row = await ctx.submit();
          const res = await ctx.decide(row.approvalId, 'approve', { reason: '' });
          expectStatus(res, 200, `approve while the receiver is ${mode}`);
          expect(ctx.data(res).status === 'Approved', `approve while the receiver is ${mode}: the row is ${ctx.data(res).status}`);
          const polled = ctx.data(await ctx.call('read', 'GET', '/proposals/' + row.approvalId));
          expect(polled && polled.status === 'Approved', `while the receiver is ${mode} the stored row must be Approved, got ${polled && polled.status}`);
          expectStatus(await ctx.execute(ctx.data(res)), 200, `write while the receiver is ${mode}`);
          // A CMS that never sends passes everything above. The failure only counts as survived if it was really tried.
          if (mode !== 'down') expect((await ctx.receiver.waitFor(row.approvalId, 1)).length >= 1, `receiver ${mode}: ${WAIT_HINT}`);
        });
      }
    }
  },
  {
    id: 'notify.slow-receiver-does-not-delay-decisions', level: 'should', title: 'A receiver that never answers does not hold up the reviewer (decision answered in under 2 s)',
    async run(ctx) {
      if (!ctx.receiver) return SKIP;
      await withReceiverMode(ctx, 'hang', async () => {
        const row = await ctx.submit();
        const started = Date.now();
        const res = await ctx.decide(row.approvalId, 'approve', { reason: '' });
        const took = Date.now() - started;
        expectStatus(res, 200, 'approve while the receiver hangs');
        expect((await ctx.receiver.waitFor(row.approvalId, 1)).length >= 1, 'the hanging receiver never got the notification, so nothing was proved. ' + WAIT_HINT);
        expect(took < 2000, `the reviewer waited ${took} ms for the agent's server. Send after answering the reviewer, or in the background (the spec allows waiting for the 3 s time-out only where a stack cannot detach)`);
      });
    }
  },
  {
    id: 'notify.redirects-are-not-followed', level: 'should', title: 'A receiver that answers with a redirect is not followed',
    async run(ctx) {
      if (!ctx.receiver) return SKIP;
      await withReceiverMode(ctx, 'redirect', async () => {
        const before = ctx.receiver.elsewhere().length;
        const { got } = await decideAndWait(ctx, 'approve', { reason: '' });
        expect(got.length >= 1, WAIT_HINT);
        await new Promise((r) => setTimeout(r, 700));
        expect(ctx.receiver.elsewhere().length === before, 'the CMS followed the receiver\'s redirect. The URL is where the operator said, not where an answer points (SSRF)');
      });
    }
  },
  {
    id: 'notify.no-retry', level: 'should', title: 'A failed delivery is not retried (at most once)',
    async run(ctx) {
      if (!ctx.receiver) return SKIP;
      await withReceiverMode(ctx, 'error', async () => {
        const { row, got } = await decideAndWait(ctx, 'approve', { reason: '' });
        expect(got.length >= 1, WAIT_HINT);
        const all = await ctx.receiver.quiet(row.approvalId, 1500);
        expect(all.length === 1, `the CMS sent ${all.length} times after the receiver answered 500; it must not retry`);
      });
    }
  },
  {
    id: 'notify.manifest-says-so', level: 'should', title: 'GET /manifest says notifications are on, and whether they are signed',
    async run(ctx) {
      if (!ctx.receiver) return SKIP;
      const res = await ctx.call('read', 'GET', '/manifest');
      expectStatus(res, 200, 'manifest');
      const n = ctx.data(res) && ctx.data(res).notifications;
      expect(n && typeof n === 'object', 'the manifest has no "notifications" field although this CMS sends them');
      expect(n.decision === true, 'notifications.decision must be true, got ' + JSON.stringify(n.decision));
      const signed = Boolean(ctx.config.notify.secret);
      expect(n.signed === signed, `notifications.signed must be ${signed} (the profile ${signed ? 'has' : 'has no'} secret), got ${JSON.stringify(n.signed)}`);
    }
  }
];
