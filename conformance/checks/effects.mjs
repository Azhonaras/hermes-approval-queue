/** Checks the CMS itself, read through a path that does not use the approval API. */
import { expect, expectStatus, expectCode } from '../assert.mjs';

export default [
  {
    id: 'effects.nothing-before-approval', level: 'must', title: 'The CMS content does not change before approval or after a refused write',
    async run(ctx) {
      if (!ctx.config.verifyUrl) return 'skipped (pass --verify-url to enable)';
      const before = await ctx.observe();
      const row = await ctx.submit();
      expect(JSON.stringify(await ctx.observe()) === JSON.stringify(before), 'CMS changed after submit alone');
      await ctx.execute(row); // refused: still Pending
      expect(JSON.stringify(await ctx.observe()) === JSON.stringify(before), 'CMS changed although the write was refused');
      await ctx.decide(row.approvalId, 'reject', { reason: 'effects check' });
      expect(JSON.stringify(await ctx.observe()) === JSON.stringify(before), 'CMS changed after a rejection');
    }
  },
  {
    id: 'effects.changes-exactly-once', level: 'must', title: 'An approved write changes the CMS once, to the approved value',
    async run(ctx) {
      if (!ctx.config.verifyUrl) return 'skipped (pass --verify-url to enable)';
      const row = await ctx.approved();
      const field = ctx.config.verifyField.split('.').pop();
      expect(field in row.proposal, `--verify-field "${ctx.config.verifyField}" must be a key of the payload`);
      expectStatus(await ctx.execute(row), 200, 'write');
      expect(await ctx.observe() === row.proposal[field], `CMS value is ${JSON.stringify(await ctx.observe())}, expected ${JSON.stringify(row.proposal[field])}`);

      expectStatus(await ctx.execute(row), 409, 'replay of the first approval');
      expect(await ctx.observe() === row.proposal[field], 'a replayed approval changed the CMS again');
    }
  },
  {
    id: 'effects.failed-write-leaves-nothing', level: 'must', title: 'If the CMS refuses the save: 502 WRITE_FAILED, nothing changed, the approval is still Approved',
    async run(ctx) {
      if (!ctx.config.verifyUrl || !ctx.config.failingPayload) return 'skipped (pass --verify-url and --failing-payload to enable)';
      const before = JSON.stringify(await ctx.observeResource());
      const row = await ctx.approved({ proposal: ctx.config.failingPayload });
      for (const attempt of ['first', 'second']) {
        expectCode(ctx, await ctx.execute(row), 502, 'WRITE_FAILED', attempt + ' attempt');
        expect(JSON.stringify(await ctx.observeResource()) === before, 'a failed write left a partial change behind (' + attempt + ' attempt)');
        const polled = ctx.data(await ctx.call('read', 'GET', '/proposals/' + row.approvalId));
        expect(polled && polled.status === 'Approved', 'after a failed write the row must be Approved again, got ' + (polled && polled.status));
      }
    }
  }
];
