/** The guard: an approval unlocks exactly one request, exactly once. */
import { expect, expectStatus, expectCode, expectGuardPassed } from '../assert.mjs';

export default [
  {
    id: 'binding.happy-path', level: 'must', title: 'The approved JSON executes and the row becomes Consumed',
    async run(ctx) {
      const row = await ctx.approved();
      const r = await ctx.execute(row);
      expectStatus(r, 200, 'write');
      expect(ctx.data(r).status === 'Consumed', 'write result must report Consumed, got ' + ctx.data(r).status);
      const after = ctx.data(await ctx.call('read', 'GET', '/proposals/' + row.approvalId));
      expect(after.status === 'Consumed', 'row must be Consumed, is ' + after.status);
    }
  },
  {
    id: 'binding.consume-once', level: 'must', title: 'A second write with the same approval is refused',
    async run(ctx) {
      const row = await ctx.approved();
      expectStatus(await ctx.execute(row), 200, 'first write');
      const again = await ctx.execute(row);
      expectCode(ctx, again, 409, 'APPROVAL_NOT_USABLE', 'second write');
    }
  },
  {
    id: 'binding.payload-bound', level: 'must', title: 'A different or extended payload is refused (the review is real)',
    async run(ctx) {
      const row = await ctx.approved();
      const field = Object.keys(row.proposal)[0];
      expectCode(ctx, await ctx.execute(row, { proposal: { ...row.proposal, [field]: 'https://evil.example/' } }), 409, 'APPROVAL_PAYLOAD_MISMATCH', 'changed value');
      expectCode(ctx, await ctx.execute(row, { proposal: { ...row.proposal, injected: 'extra' } }), 409, 'APPROVAL_PAYLOAD_MISMATCH', 'added field');
      const rest = { ...row.proposal }; delete rest[field];
      expectCode(ctx, await ctx.execute(row, { proposal: rest }), 409, 'APPROVAL_PAYLOAD_MISMATCH', 'removed field');
      expectStatus(await ctx.execute(row), 200, 'the exact approved JSON must still work after the refused attempts');
    }
  },
  {
    id: 'binding.resource-action-scope-bound', level: 'must', title: 'A different resource, action or scope is refused',
    async run(ctx) {
      const row = await ctx.approved();
      expectCode(ctx, await ctx.execute(row, { resourceId: ctx.config.otherResourceId }), 409, 'APPROVAL_MISMATCH', 'other resourceId');
      expectCode(ctx, await ctx.execute(row, { resourceType: row.resourceType + '-other' }), 409, 'APPROVAL_MISMATCH', 'other resourceType');
      if (ctx.config.otherAction) expectCode(ctx, await ctx.execute(row, { action: ctx.config.otherAction }), 409, 'APPROVAL_MISMATCH', 'other action');
      if (ctx.config.otherScope) expectCode(ctx, await ctx.execute(row, { scope: ctx.config.otherScope }), 409, 'APPROVAL_MISMATCH', 'other scope');
      expectStatus(await ctx.execute(row), 200, 'the exact approved request must still work');
    }
  },
  {
    id: 'binding.unknown-approval', level: 'must', title: 'Writing with an unknown approvalId is a 404',
    async run(ctx) {
      const row = await ctx.approved();
      expectStatus(await ctx.execute(row, { approvalId: 987654321 }), 404, 'unknown approvalId');
    }
  },
  {
    id: 'binding.key-order-irrelevant', level: 'should', title: 'JSON key order does not matter (canonical comparison)',
    async run(ctx) {
      const row = await ctx.approved({ proposal: { ...ctx.submission().proposal, zz_second: 'b', aa_first: 'a' } });
      const reversed = Object.fromEntries(Object.entries(row.proposal).reverse());
      const r = await ctx.execute(row, { proposal: reversed });
      expectGuardPassed(ctx, r, 'write with reordered keys');
    }
  },
  {
    id: 'binding.reviewer-edit', level: 'extension', title: 'Reviewer can edit the payload; the agent must then write the edited JSON',
    async run(ctx) {
      const row = await ctx.submit();
      const field = Object.keys(row.proposal)[0];
      // Keep the value's shape: a CMS that validates URLs must still accept the reviewer's edit.
      const looksLikeUrl = typeof row.proposal[field] === 'string' && /^https?:\/\//.test(row.proposal[field]);
      const edited = { ...row.proposal, [field]: (looksLikeUrl ? 'https://example.com/edited-by-reviewer-' : 'edited-by-reviewer-') + ctx.unique() };
      const a = await ctx.decide(row.approvalId, 'approve', { reason: '', proposal: edited });
      if (a.http === 400 || a.http === 404 || a.http === 405) return 'skipped (edit extension not supported)';
      expectStatus(a, 200, 'approve with edited proposal');
      expect(ctx.data(a).proposal[field] === edited[field], 'stored proposal must be the edited one');
      expectCode(ctx, await ctx.execute(row), 409, 'APPROVAL_PAYLOAD_MISMATCH', 'agent writes its original after an edit');
      expectStatus(await ctx.execute(ctx.data(a)), 200, 'agent writes the edited JSON');
    }
  }
];
