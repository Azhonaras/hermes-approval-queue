/** Deployment hygiene. Failing these is a warning, not a protocol violation. */
import { expect } from '../assert.mjs';

export default [
  {
    id: 'hygiene.no-wildcard-cors', level: 'should', title: 'No "Access-Control-Allow-Origin: *" on a CMS that holds credentials',
    async run(ctx) {
      const r = await ctx.call('none', 'GET', '/ping', undefined, { extraHeaders: { Origin: 'https://attacker.example' } });
      const allow = r.headers.get('access-control-allow-origin');
      expect(allow !== '*', 'wildcard CORS lets any website call the API from a visitor\'s browser. Demo only; remove before production');
      expect(allow !== 'https://attacker.example', 'CORS reflects any Origin');
    }
  },
  {
    id: 'hygiene.no-secrets-in-errors', level: 'should', title: 'Error responses do not leak stack traces or file paths',
    async run(ctx) {
      const r = await ctx.call('write', 'POST', '/proposals', undefined, { rawBody: '{broken' });
      expect(!/\bat .+\(.+:\d+:\d+\)|[A-Z]:\\|\/home\/|\/var\/www|Exception|Traceback/.test(r.text), 'error body looks like a stack trace or contains a path');
    }
  },
  {
    id: 'hygiene.api-key-not-in-body', level: 'should', title: 'API keys are never echoed back in responses',
    async run(ctx) {
      const key = ctx.config.writeHeader.split(':').slice(1).join(':').trim();
      const row = await ctx.submit();
      const r = await ctx.call('write', 'GET', '/proposals/' + row.approvalId);
      expect(!r.text.includes(key), 'the write key appears in a response body');
    }
  }
];
