/** Status transitions: pending, approve, reject, request-changes, revisions, listing. */
import { expect, expectStatus, expectCode, expectOneOf } from '../assert.mjs';

export default [
  {
    id: 'lifecycle.write-blocked-while-pending', level: 'must', title: 'A write is refused until a human approves',
    async run(ctx) {
      const row = await ctx.submit();
      expectCode(ctx, await ctx.execute(row), 409, 'APPROVAL_PENDING', 'write while Pending');
    }
  },
  {
    id: 'lifecycle.approve-records-reviewer', level: 'must', title: 'Approve moves Pending -> Approved and records who decided',
    async run(ctx) {
      const row = await ctx.submit();
      const r = await ctx.decide(row.approvalId, 'approve', { reason: '' });
      expectStatus(r, 200, 'approve');
      const done = ctx.data(r);
      expect(done.status === 'Approved', 'status must be Approved, got ' + done.status);
      expect(done.decidedBy, 'decidedBy must name the reviewer');
      expect(done.decidedUtc, 'decidedUtc must be set');
    }
  },
  {
    id: 'lifecycle.decide-once', level: 'must', title: 'A decided row cannot be decided again',
    async run(ctx) {
      const row = await ctx.submit();
      await ctx.decide(row.approvalId, 'approve');
      expectCode(ctx, await ctx.decide(row.approvalId, 'approve'), 409, 'APPROVAL_NOT_PENDING', 'second approve');
      expectCode(ctx, await ctx.decide(row.approvalId, 'reject', { reason: 'too late' }), 409, 'APPROVAL_NOT_PENDING', 'reject after approve');
    }
  },
  {
    id: 'lifecycle.reject-needs-reason', level: 'must', title: 'Reject and request-changes require a written reason',
    async run(ctx) {
      const a = await ctx.submit();
      expectCode(ctx, await ctx.decide(a.approvalId, 'reject', { reason: '' }), 400, 'DECISION_REASON_REQUIRED', 'reject without reason');
      expectCode(ctx, await ctx.decide(a.approvalId, 'reject', { reason: '   ' }), 400, 'DECISION_REASON_REQUIRED', 'reject with blank reason');
      expectCode(ctx, await ctx.decide(a.approvalId, 'request-changes', {}), 400, 'DECISION_REASON_REQUIRED', 'request-changes without reason');
      const still = ctx.data(await ctx.call('read', 'GET', '/proposals/' + a.approvalId));
      expect(still.status === 'Pending', 'a refused decision must leave the row Pending');
    }
  },
  {
    id: 'lifecycle.rejected-cannot-write', level: 'must', title: 'Rejected and ChangesRequested rows can never be written',
    async run(ctx) {
      const rejected = await ctx.submit();
      await ctx.decide(rejected.approvalId, 'reject', { reason: 'no' });
      expectCode(ctx, await ctx.execute(rejected), 409, 'APPROVAL_NOT_USABLE', 'write after reject');
      const changes = await ctx.submit();
      await ctx.decide(changes.approvalId, 'request-changes', { reason: 'shorter' });
      expectCode(ctx, await ctx.execute(changes), 409, 'APPROVAL_NOT_USABLE', 'write after request-changes');
    }
  },
  {
    id: 'lifecycle.revision-flow', level: 'must', title: 'A revision is a new row; the parent stays ChangesRequested',
    async run(ctx) {
      const parent = await ctx.submit();
      await ctx.decide(parent.approvalId, 'request-changes', { reason: 'please shorten' });
      const rev = await ctx.submit({ revisionOfApprovalId: parent.approvalId });
      expect(rev.approvalId !== parent.approvalId, 'revision must get a new id');
      expect(rev.revisionOfApprovalId === parent.approvalId, 'revisionOfApprovalId must point at the parent');
      expect(rev.status === 'Pending', 'revision must start Pending');
      const after = ctx.data(await ctx.call('read', 'GET', '/proposals/' + parent.approvalId));
      expect(after.status === 'ChangesRequested', 'parent must be untouched, is ' + after.status);
    }
  },
  {
    id: 'lifecycle.revision-rules', level: 'must', title: 'A revision needs a ChangesRequested parent with the same resource',
    async run(ctx) {
      const pending = await ctx.submit();
      expectCode(ctx, await ctx.call('write', 'POST', '/proposals', ctx.submission({ revisionOfApprovalId: pending.approvalId })),
        409, 'REVISION_NOT_REQUESTED', 'revision of a Pending row');
      expectStatus(await ctx.call('write', 'POST', '/proposals', ctx.submission({ revisionOfApprovalId: 987654321 })), 404, 'revision of a missing row');

      const parent = await ctx.submit();
      await ctx.decide(parent.approvalId, 'request-changes', { reason: 'fix' });
      expectCode(ctx, await ctx.call('write', 'POST', '/proposals', ctx.submission({ revisionOfApprovalId: parent.approvalId, resourceId: ctx.config.otherResourceId })),
        409, 'REVISION_MISMATCH', 'revision that moves to another resource');
    }
  },
  {
    id: 'lifecycle.listing', level: 'must', title: 'Queue shows Pending rows; history shows decided rows; unknown filters are refused',
    async run(ctx) {
      const pending = await ctx.submit();
      const decided = await ctx.submit();
      await ctx.decide(decided.approvalId, 'reject', { reason: 'listing check' });
      const ids = async (status) => (ctx.data(await ctx.call('review', 'GET', '/proposals?status=' + status)) || []).map((r) => r.approvalId);
      const queue = await ids('pending');
      const history = await ids('history');
      expect(queue.includes(pending.approvalId), 'pending list is missing the new row');
      expect(!queue.includes(decided.approvalId), 'pending list must not contain a decided row');
      expect(history.includes(decided.approvalId), 'history is missing the rejected row');
      expect(!history.includes(pending.approvalId), 'history must not contain a Pending row');
      expectStatus(await ctx.call('review', 'GET', '/proposals?status=all'), 400, 'unknown status filter');
    }
  },
  {
    id: 'lifecycle.expired-fixture', level: 'should', title: 'An expired approval is refused with APPROVAL_EXPIRED (needs --expired-fixture)',
    async run(ctx) {
      const f = ctx.config.expiredFixture;
      if (!f) return 'skipped';
      const r = await ctx.call('write', 'POST', '/writes', f);
      expectCode(ctx, r, 409, 'APPROVAL_EXPIRED', 'write with an expired approval');
    }
  }
];
