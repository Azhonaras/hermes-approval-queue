/** Load that a one-request-at-a-time test never produces: deadlocks, lost updates, connection exhaustion. */
import { expect } from '../assert.mjs';

const flow = async (ctx) => {
  const row = await ctx.submit();
  const approved = await ctx.decide(row.approvalId, 'approve', {});
  const write = await ctx.execute(row);
  return { id: row.approvalId, approve: approved.http, write: write.http };
};

export default [
  {
    id: 'stress.parallel-flows', level: 'must', title: '60 complete submit -> approve -> write flows at once all succeed',
    async run(ctx) {
      const results = await Promise.all(Array.from({ length: 60 }, () => flow(ctx)));
      const bad = results.filter((r) => r.approve !== 200 || r.write !== 200);
      expect(!bad.length, `${bad.length}/60 flows failed, e.g. approve ${bad[0]?.approve} write ${bad[0]?.write}`);
      expect(new Set(results.map((r) => r.id)).size === 60, 'approval ids must be unique under load');
    }
  },
  {
    id: 'stress.contended-claims', level: 'must', title: '30 approvals x 4 simultaneous writes each: exactly 30 writes succeed, no 5xx',
    async run(ctx) {
      const rows = [];
      for (let i = 0; i < 30; i += 1) rows.push(await ctx.approved());
      const attempts = await Promise.all(rows.flatMap((row) => Array.from({ length: 4 }, () => ctx.execute(row))));
      const wins = attempts.filter((r) => r.http === 200).length;
      const serverErrors = attempts.filter((r) => r.http >= 500).length;
      expect(serverErrors === 0, `${serverErrors} write(s) failed with a 5xx (deadlock victim?)`);
      expect(wins === 30, `expected exactly 30 successful writes, got ${wins}`);
      const perApproval = rows.map((row, i) => attempts.slice(i * 4, i * 4 + 4).filter((r) => r.http === 200).length);
      expect(perApproval.every((n) => n === 1), 'every approval must be consumed exactly once: ' + perApproval.join(','));
    }
  },
  {
    id: 'stress.contended-decisions', level: 'must', title: '40 rows decided by 3 competing reviewers each: one decision per row, no 5xx',
    async run(ctx) {
      const rows = [];
      for (let i = 0; i < 40; i += 1) rows.push(await ctx.submit());
      const verbs = [['approve', {}], ['reject', { reason: 'r' }], ['request-changes', { reason: 'c' }]];
      const attempts = await Promise.all(rows.flatMap((row) => verbs.map(([v, b]) => ctx.decide(row.approvalId, v, b))));
      expect(attempts.every((r) => r.http < 500), `${attempts.filter((r) => r.http >= 500).length} decision(s) gave a 5xx`);
      const wins = rows.map((_, i) => attempts.slice(i * 3, i * 3 + 3).filter((r) => r.http === 200).length);
      expect(wins.every((n) => n === 1), 'each row must get exactly one decision: ' + wins.join(','));
    }
  },
  {
    id: 'stress.reads-during-writes', level: 'should', title: 'Polling and listing stay healthy while writes are running',
    async run(ctx) {
      const rows = [];
      for (let i = 0; i < 10; i += 1) rows.push(await ctx.approved());
      const jobs = [
        ...rows.map((row) => ctx.execute(row)),
        ...Array.from({ length: 30 }, () => ctx.call('review', 'GET', '/proposals?status=history')),
        ...rows.map((row) => ctx.call('read', 'GET', '/proposals/' + row.approvalId))
      ];
      const results = await Promise.all(jobs);
      expect(results.every((r) => r.http < 500), 'a request failed with a 5xx while the system was busy');
    }
  }
];
