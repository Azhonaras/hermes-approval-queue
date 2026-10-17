/** What a submission must look like before a human is asked to read it. */
import { expect, expectStatus, expectCode } from '../assert.mjs';

export default [
  {
    id: 'validation.submit-pending', level: 'must', title: 'A valid submission becomes Pending and echoes the exact JSON',
    async run(ctx) {
      const sent = ctx.submission();
      const r = await ctx.call('write', 'POST', '/proposals', sent);
      expectStatus(r, 200, 'submit');
      const row = ctx.data(r);
      expect(row.status === 'Pending', 'status must be Pending, got ' + row.status);
      expect(row.approvalId !== undefined && row.approvalId !== null, 'row needs an approvalId');
      expect(JSON.stringify(Object.keys(row.proposal).sort()) === JSON.stringify(Object.keys(sent.proposal).sort()), 'proposal fields were changed on the way in');
      expect(row.action === sent.action && row.scope === sent.scope, 'action/scope must be stored as sent');
      expect(row.expiresUtc, 'row must carry expiresUtc');
    }
  },
  {
    id: 'validation.bare-update-refused', level: 'must', title: 'A bare "update" action is refused (an approval must map to one write path)',
    async run(ctx) {
      expectCode(ctx, await ctx.call('write', 'POST', '/proposals', ctx.submission({ action: 'update' })), 400, 'BAD_REQUEST', 'bare update');
    }
  },
  {
    id: 'validation.unknown-action-scope', level: 'must', title: 'Unknown action or scope is refused',
    async run(ctx) {
      expectStatus(await ctx.call('write', 'POST', '/proposals', ctx.submission({ action: 'drop:everything' })), 400, 'unknown action');
      expectStatus(await ctx.call('write', 'POST', '/proposals', ctx.submission({ scope: 'root:all' })), 400, 'unknown scope');
    }
  },
  {
    id: 'validation.resource-required', level: 'must', title: 'resourceType and resourceId are required',
    async run(ctx) {
      expectStatus(await ctx.call('write', 'POST', '/proposals', ctx.submission({ resourceType: '' })), 400, 'empty resourceType');
      expectStatus(await ctx.call('write', 'POST', '/proposals', ctx.submission({ resourceId: null })), 400, 'null resourceId');
    }
  },
  {
    id: 'validation.proposal-must-be-object', level: 'must', title: 'proposal must be a non-empty JSON object',
    async run(ctx) {
      for (const bad of [['a'], 'text', 42, null, {}]) {
        expectStatus(await ctx.call('write', 'POST', '/proposals', ctx.submission({ proposal: bad })), 400, 'proposal=' + JSON.stringify(bad));
      }
    }
  },
  {
    id: 'validation.reviewable-size', level: 'must', title: 'An unreviewably large proposal is refused',
    async run(ctx) {
      const huge = { [Object.keys(ctx.submission().proposal)[0]]: 'x'.repeat(20000) };
      expectStatus(await ctx.call('write', 'POST', '/proposals', ctx.submission({ proposal: huge })), 400, '20 000-character proposal');
      const many = Object.fromEntries(Array.from({ length: 60 }, (_, i) => ['f' + i, i]));
      expectStatus(await ctx.call('write', 'POST', '/proposals', ctx.submission({ proposal: many })), 400, '60-field proposal');
    }
  },
  {
    id: 'validation.malformed-json', level: 'must', title: 'Malformed JSON is a 4xx, never a 500',
    async run(ctx) {
      const r = await ctx.call('write', 'POST', '/proposals', undefined, { rawBody: '{not json' });
      expect(r.http >= 400 && r.http < 500, `malformed JSON must be 4xx, got ${r.http}`);
    }
  },
  {
    id: 'validation.unicode-roundtrip', level: 'must', title: 'Non-ASCII text is stored exactly (no "?" substitution)',
    async run(ctx) {
      const key = Object.keys(ctx.submission().proposal)[0];
      const text = 'عنوان نمونه — café 日本語 🙂';
      const row = await ctx.submit({ proposal: { [key]: text }, reason: 'دلیل: ' + text });
      const back = ctx.data(await ctx.call('read', 'GET', '/proposals/' + row.approvalId));
      expect(back.proposal[key] === text, `proposal text changed: ${JSON.stringify(back.proposal[key])}`);
      expect(back.reason === 'دلیل: ' + text, 'reason text changed');
    }
  },
  {
    id: 'validation.delete-may-be-empty', level: 'should', title: 'delete:* actions may send an empty proposal',
    async run(ctx) {
      const del = ctx.config.deleteAction;
      if (!del) return 'skipped';
      const r = await ctx.call('write', 'POST', '/proposals', ctx.submission({ action: del, proposal: {} }));
      expectStatus(r, 200, 'delete with empty proposal');
    }
  }
];
