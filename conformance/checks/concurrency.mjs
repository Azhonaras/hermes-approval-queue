/** Races. These are the failures a single-threaded test never sees. */
import { expect } from '../assert.mjs';

export default [
  {
    id: 'concurrency.one-write-wins', level: 'must', title: 'Eight parallel writes of one approval: exactly one succeeds',
    async run(ctx) {
      const row = await ctx.approved();
      const results = await Promise.all(Array.from({ length: 8 }, () => ctx.execute(row)));
      const wins = results.filter((r) => r.http === 200).length;
      const statuses = results.map((r) => r.http).join(',');
      expect(wins === 1, `exactly one write must win, ${wins} did (HTTP ${statuses})`);
      expect(results.filter((r) => r.http !== 200).every((r) => r.http === 409), 'every losing write must be 409, got ' + statuses);
    }
  },
  {
    id: 'concurrency.one-decision-wins', level: 'must', title: 'Approve and reject at the same moment: exactly one decision is recorded',
    async run(ctx) {
      const row = await ctx.submit();
      const results = await Promise.all([
        ctx.decide(row.approvalId, 'approve', {}),
        ctx.decide(row.approvalId, 'reject', { reason: 'race' }),
        ctx.decide(row.approvalId, 'approve', {}),
        ctx.decide(row.approvalId, 'request-changes', { reason: 'race' })
      ]);
      const wins = results.filter((r) => r.http === 200).length;
      expect(wins === 1, `exactly one decision must win, ${wins} did`);
      const final = ctx.data(await ctx.call('read', 'GET', '/proposals/' + row.approvalId));
      expect(final.status !== 'Pending', 'row must be decided');
    }
  }
];
