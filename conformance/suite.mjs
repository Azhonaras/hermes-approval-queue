/** Runs the checks and returns structured results. No console output here, so tests can reuse it. */
import { createContext } from './context.mjs';
import { CheckFailure } from './assert.mjs';
import doors from './checks/doors.mjs';
import validation from './checks/validation.mjs';
import lifecycle from './checks/lifecycle.mjs';
import binding from './checks/binding.mjs';
import concurrency from './checks/concurrency.mjs';
import effects from './checks/effects.mjs';
import hygiene from './checks/hygiene.mjs';
import edge from './checks/edge.mjs';
import stress from './checks/stress.mjs';
import notify from './checks/notify.mjs';
import { startReceiver } from './receiver.mjs';

export const ALL_CHECKS = [...doors, ...validation, ...lifecycle, ...binding, ...edge, ...concurrency, ...stress, ...effects, ...notify, ...hygiene];

/**
 * level: 'must' (protocol), 'should' (recommended / hygiene), 'extension' (optional feature).
 * outcome: 'pass' | 'fail' | 'skip'. A thrown non-assertion error is a failure too. A check that returns "note: ..." passes and
 * keeps the text as its detail, for something the reader should know about the target.
 *
 * With `config.notify` the suite also listens on that port for the whole run, so a CMS that is set up to send decision
 * notifications always has somewhere to send them; the `notify` group needs it and is skipped without it.
 */
export async function runSuite(config, { only, onResult } = {}) {
  const ctx = createContext(config);
  const checks = only ? ALL_CHECKS.filter((c) => c.id.startsWith(only)) : ALL_CHECKS;
  const results = [];
  if (config.notify) ctx.receiver = await startReceiver({ port: config.notify.port, host: config.notify.host });
  try {
    for (const check of checks) {
      const started = Date.now();
      let outcome = 'pass';
      let detail = '';
      try {
        const returned = await check.run(ctx);
        if (typeof returned === 'string' && returned.startsWith('skipped')) { outcome = 'skip'; detail = returned; }
        else if (typeof returned === 'string' && returned.startsWith('note:')) detail = returned; // a pass that says what it saw
      } catch (err) {
        outcome = 'fail';
        detail = err instanceof CheckFailure ? err.message : 'Unexpected error: ' + (err && err.message ? err.message : err);
      }
      const result = { id: check.id, level: check.level, title: check.title, outcome, detail, ms: Date.now() - started };
      results.push(result);
      if (onResult) onResult(result);
    }
  } finally {
    if (ctx.receiver) await ctx.receiver.close();
  }
  return { results, summary: summarize(results, config) };
}

export function summarize(results, config = {}) {
  const count = (fn) => results.filter(fn).length;
  const mustFailed = count((r) => r.level === 'must' && r.outcome === 'fail');
  const shouldFailed = count((r) => r.level !== 'must' && r.outcome === 'fail');
  const passed = count((r) => r.outcome === 'pass');
  const skipped = count((r) => r.outcome === 'skip');
  const conformant = mustFailed === 0 && (!config.strict || shouldFailed === 0);
  return { total: results.length, passed, skipped, mustFailed, shouldFailed, conformant };
}
