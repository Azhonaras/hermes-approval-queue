/**
 * Runs the conformance suite in-process: once against the real demo (must pass), then against
 * deliberately broken variants (each must be caught by the check that guards that rule).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { createDemoApp } from '../../demo-cms/server.mjs';
import { createWebhookNotifier, decisionBody, signDelivery } from '../../src/server/notify/webhook.mjs';
import { buildConfig } from '../../conformance/config.mjs';
import { runSuite } from '../../conformance/suite.mjs';

const profile = (port) => {
  const text = fs.readFileSync(new URL('../../conformance/profiles/demo-cms.json', import.meta.url), 'utf8').replaceAll('8790', String(port));
  return buildConfig({ config: 'inline' }, () => text);
};

const freePort = () => new Promise((resolve, reject) => {
  const probe = net.createServer();
  probe.once('error', reject);
  probe.listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
});

const SECRET = 'e2e-notify-secret';

/**
 * `notify`: the demo sends decision notifications to a port the suite listens on (signed with `secret`, or unsigned with '').
 * `only`: a check id prefix, to run one group.
 */
async function runAgainst(mutate, options = {}) {
  // A probed port can be taken by another server starting in parallel before the suite listens on it: try a new one.
  for (let attempt = 1; ; attempt += 1) {
    try { return await runOnce(mutate, options); }
    catch (err) { if (err.code !== 'EADDRINUSE' || attempt >= 5) throw err; }
  }
}

async function runOnce(mutate, { notify = false, secret = SECRET, only } = {}) {
  const notifyPort = notify ? await freePort() : 0;
  const webhook = notify ? { url: 'http://127.0.0.1:' + notifyPort + '/hook', secret, logger: { warn() {} } } : null;
  const app = createDemoApp({ mutate, webhook });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  try {
    const config = profile(app.server.address().port);
    if (notify) config.notify = { port: notifyPort, secret, host: '127.0.0.1' };
    return await runSuite(config, { only });
  } finally {
    await new Promise((r) => app.server.close(r));
  }
}
const failedIds = (run) => run.results.filter((r) => r.outcome === 'fail').map((r) => r.id);
const MALFORMED_ESCAPE = /%(?![0-9a-f]{2})/i;

// One full run with notifications on serves both reference tests (and is the only one where nothing may be skipped).
const reference = runAgainst({}, { notify: true });
reference.catch(() => {});

test('the reference server passes every MUST check', async () => {
  const run = await reference;
  assert.deepEqual(failedIds(run).filter((id) => !id.startsWith('hygiene.')), []);
  assert.equal(run.summary.conformant, true);
  assert.equal(run.summary.skipped, 0, 'nothing should be skipped against the demo profile');
  assert.equal(run.results.filter((r) => r.id.startsWith('notify.') && r.outcome === 'pass').length, 9, 'the whole notify group should pass');
});

test('the demo CORS warning is reported but does not fail conformance', async () => {
  assert.deepEqual(failedIds(await reference), ['hygiene.no-wildcard-cors']);
});

test('without notify settings the notify group is skipped, never failed', async () => {
  const run = await runAgainst({}, { only: 'notify.' });
  const notifyResults = run.results.filter((r) => r.id.startsWith('notify.'));
  assert.equal(notifyResults.length, 9);
  assert.ok(notifyResults.every((r) => r.outcome === 'skip'));
});

test('an unsigned deployment passes too: the signature check is skipped and the manifest says unsigned', async () => {
  const run = await runAgainst({}, { notify: true, secret: '', only: 'notify.' });
  assert.deepEqual(failedIds(run), []);
  assert.deepEqual(run.results.filter((r) => r.outcome === 'skip').map((r) => r.id), ['notify.signature-verifies']);
});

const MUTANTS = [
  {
    name: 'write is not bound to the approved payload',
    mutate: { service: (svc) => ({ ...svc, execute: async (w) => {
      const row = await svc.get(w.approvalId);
      return svc.execute({ ...w, resourceType: row.resourceType, resourceId: row.resourceId, action: row.action, scope: row.scope, proposal: row.proposal });
    } }) },
    expect: ['binding.payload-bound', 'binding.resource-action-scope-bound']
  },
  {
    name: 'approval is never consumed',
    mutate: { store: (store) => ({ ...store, transition: async (id, from, patch) =>
      (patch.status === 'Consumed' ? store.get(id) : store.transition(id, from, patch)) }) },
    expect: ['binding.consume-once', 'concurrency.one-write-wins']
  },
  {
    name: 'claim is not atomic (no conditional update)',
    mutate: { store: (store) => ({ ...store, transition: async (id, from, patch) => {
      await new Promise((r) => setTimeout(r, 5));
      return store.transition(id, (await store.get(id)).status, patch);
    } }) },
    expect: ['concurrency.one-write-wins', 'concurrency.one-decision-wins']
  },
  {
    name: 'write allowed while still Pending',
    mutate: { service: (svc, store) => ({ ...svc, execute: async (w) => {
      const row = await store.get(Number(w.approvalId));
      if (row && row.status === 'Pending') await store.transition(row.approvalId, 'Pending', { status: 'Approved' });
      return svc.execute(w);
    } }) },
    expect: ['lifecycle.write-blocked-while-pending']
  },
  {
    name: 'the agent key can approve (self-approval)',
    mutate: { doors: (d) => ({
      agent: (req) => (/\/(approve|reject|request-changes)$/.test(req.url) ? { read: true, write: false } : d.agent(req)),
      reviewer: (req) => (req.headers['x-api-key'] === 'demo-write' ? { id: 'agent-itself' } : d.reviewer(req))
    }) },
    expect: ['doors.write-key-cannot-approve']
  },
  {
    name: 'submissions are not validated',
    mutate: { service: (svc, store) => ({ ...svc, submit: async (body) => store.insert({
      ...body, status: 'Pending', decisionReason: null, createdUtc: new Date().toISOString(), decidedUtc: null, decidedBy: null,
      expiresUtc: new Date(Date.now() + 86400000).toISOString(), editedProposal: false, originalProposal: null }) }) },
    expect: ['validation.bare-update-refused', 'validation.proposal-must-be-object']
  },
  {
    name: 'request bodies are parsed with plain JSON.parse (duplicate keys, huge integers, 1e999 accepted)',
    mutate: { http: (handler) => async (req, res, next) => {
      if (req.method === 'POST') {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const text = Buffer.concat(chunks).toString('utf8');
        try { req.body = text ? JSON.parse(text) : {}; } catch { req.body = {}; }
      }
      return handler(req, res, next);
    } },
    expect: ['edge.duplicate-keys-refused', 'edge.numbers-are-doubles', 'edge.nesting-limit']
  },
  {
    name: 'path segments are decoded twice',
    mutate: { http: (handler) => (req, res, next) => {
      const [path, query] = req.url.split('?');
      try { req.url = decodeURIComponent(path) + (query ? '?' + query : ''); } catch { /* leave as is */ }
      return handler(req, res, next);
    } },
    expect: ['edge.path-rules']
  },
  {
    // The bug that .NET and PHP had: "$" also matches before a final newline, so "42\n" was read as 42 and siteId "1\n" as 1.
    name: 'a trailing newline after an id or siteId is tolerated',
    mutate: { http: (handler) => (req, res, next) => {
      req.url = req.url.replace(/%0A(?=[?&]|$)/gi, '');
      return handler(req, res, next);
    } },
    expect: ['edge.path-rules', 'edge.query-rules']
  },
  {
    name: 'the path is normalized before routing ("..", "%2e%2e" and "\\" are resolved)',
    mutate: { http: (handler) => (req, res, next) => {
      const url = new URL(req.url, 'http://localhost');
      req.url = url.pathname + url.search;
      return handler(req, res, next);
    } },
    expect: ['edge.paths-are-not-normalized'],
    conformant: true // a SHOULD check: a web server in front may normalize paths before the application sees them
  },
  {
    // The bug the fuzzer found in the Node reference: the body was parsed before the door was checked.
    name: 'the body is parsed before the door is checked',
    mutate: { http: (handler) => (req, res, next) => {
      if (req.method !== 'POST') return handler(req, res, next);
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        try {
          req.body = text ? JSON.parse(text) : {};
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: { code: 'BAD_REQUEST', message: 'The body is not JSON.' } }));
          return;
        }
        handler(req, res, next);
      });
      return true; // handled (the demo falls through to its static files when the handler returns a falsy value)
    } },
    expect: ['doors.door-comes-first']
  },
  {
    // Only the CMS's own URLs answer 400, so this is the CMS reading the path before the door, not a web server in front.
    name: 'a malformed % escape in the path is answered with 400 before the door',
    mutate: { http: (handler) => (req, res, next) => {
      if (req.url.startsWith('/api/seo') && MALFORMED_ESCAPE.test(req.url)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: { code: 'BAD_REQUEST', message: 'The path is not valid.' } }));
        return true;
      }
      return handler(req, res, next);
    } },
    expect: ['doors.door-comes-first']
  },
  {
    name: 'the Content-Type is ignored (every body is read as JSON)',
    mutate: { http: (handler) => (req, res, next) => { req.headers['content-type'] = 'application/json'; return handler(req, res, next); } },
    expect: ['edge.content-type']
  },
  {
    // PHP-FPM hands PHP an empty CONTENT_TYPE for a request without one; a port that takes it for a real type refuses a bodiless request.
    name: 'a request with no Content-Type and no body is refused as an unsupported media type',
    mutate: { http: (handler) => (req, res, next) => {
      if (req.method === 'POST' && req.headers['content-type'] === undefined && /^(0)?$/.test(req.headers['content-length'] ?? '')) {
        res.writeHead(415, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: { code: 'UNSUPPORTED_MEDIA_TYPE', message: 'Send the body as application/json.' } }));
        return true;
      }
      return handler(req, res, next);
    } },
    expect: ['edge.content-type']
  },
  {
    name: 'query parameter names are matched case-insensitively',
    mutate: { http: (handler) => (req, res, next) => {
      req.url = req.url.replace(/([?&])(siteid|status)=/gi, (_, sep, name) => sep + (name.toLowerCase() === 'siteid' ? 'siteId' : 'status') + '=');
      return handler(req, res, next);
    } },
    expect: ['edge.query-names-are-exact']
  },
  {
    // PHP folds X_Api_Key into the same variable as X-Api-Key; a stack that does the same accepts a header nobody sent.
    name: 'an X_Api_Key header (underscores) is accepted as X-Api-Key',
    mutate: { http: (handler) => (req, res, next) => {
      if (req.headers['x_api_key'] !== undefined && req.headers['x-api-key'] === undefined) req.headers['x-api-key'] = req.headers['x_api_key'];
      return handler(req, res, next);
    } },
    expect: ['edge.api-key-header-name'],
    conformant: true // a SHOULD check: PHP behind most SAPIs cannot tell the two names apart
  },
  {
    name: 'a reviewer reason of any type is accepted (coerced to text)',
    mutate: { service: (svc) => ({ ...svc, decide: (id, verb, input = {}) => svc.decide(id, verb, { ...input, reason: input.reason == null ? input.reason : String(input.reason).slice(0, 1024) }) }) },
    expect: ['edge.decision-input-strict']
  }
];

for (const mutant of MUTANTS) {
  test(`suite catches a faulty server: ${mutant.name}`, async () => {
    const run = await runAgainst(mutant.mutate);
    assert.equal(run.summary.conformant, mutant.conformant ?? false, mutant.conformant ? 'only a SHOULD check is expected to fail' : 'a broken server must not be reported as conformant');
    const failed = failedIds(run);
    for (const id of mutant.expect) assert.ok(failed.includes(id), `expected ${id} to fail; failed: ${failed.join(', ')}`);
  });
}

test('a web server that refuses a malformed % escape for every URL is not blamed on the CMS, and the report says so', async () => {
  const inFront = { http: (handler) => (req, res, next) => {
    if (MALFORMED_ESCAPE.test(req.url)) {
      res.writeHead(400, { 'Content-Type': 'text/html' });
      res.end('<html><body><h1>400 Bad Request</h1></body></html>');
      return true;
    }
    return handler(req, res, next);
  } };
  const run = await runAgainst(inFront, { only: 'doors' });
  const door = run.results.find((r) => r.id === 'doors.door-comes-first');
  assert.equal(door.outcome, 'pass', door.detail);
  assert.match(door.detail, /^note: the web server in front of the CMS answered 400/);
  assert.match(door.detail, /GET \/resources\/\w+\/%zz/);
  assert.equal(run.summary.conformant, true);
});

// ---- Decision notifications ---------------------------------------------------------------------------------------
// Each mutant is a port that gets one rule of docs/spec.md "Decision notifications" wrong. The notify group must say so.

const quietLogger = { warn() {} };

/** The real notifier, but every outgoing request goes through `fetchImpl`: how a faulty sender is simulated. */
const through = (webhook, fetchImpl) => createWebhookNotifier({ ...webhook, logger: quietLogger, fetchImpl });

/** Stands in for the real notifier so a mutant can send (or not send) in its own way. Keeps the manifest's note. */
const muted = (notifier) => notifier && { signed: notifier.signed, decided: async () => {} };

/** Sends `body` the way the real notifier would, signed with `secret`; awaited by the caller, errors swallowed. */
async function sendBody(webhook, body, { secret = webhook.secret, timeoutMs = 3000 } = {}) {
  const headers = { 'content-type': 'application/json', 'x-hermes-delivery': randomUUID() };
  if (secret) {
    const timestamp = String(Math.floor(Date.now() / 1000));
    headers['x-hermes-timestamp'] = timestamp;
    headers['x-hermes-signature'] = signDelivery(secret, timestamp, body);
  }
  try {
    const res = await fetch(webhook.url, { method: 'POST', headers, body, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
    return res;
  } catch { return null; }
}
/** A notifier built from `bodyFor(row)`: one body, or a list of them, each sent in turn. */
const custom = (webhook, bodyFor, options) => ({
  signed: Boolean(webhook.secret),
  decided: async (row) => { for (const body of [].concat(bodyFor(row))) await sendBody(webhook, body, options); }
});

const NOTIFY_MUTANTS = [
  {
    name: 'the notification carries the proposal and the reasons',
    mutate: { notifier: (n, w) => custom(w, (row) => JSON.stringify({
      event: 'decision', approvalId: row.approvalId, status: row.status, decidedUtc: row.decidedUtc,
      reason: row.reason, decisionReason: row.decisionReason, proposal: row.proposal
    })) },
    expect: ['notify.decision-is-announced', 'notify.nudge-carries-no-content']
  },
  {
    name: 'the notification says Approved whatever the decision was',
    mutate: { notifier: (n, w) => custom(w, (row) => decisionBody({ ...row, status: 'Approved' })) },
    expect: ['notify.decision-is-announced']
  },
  {
    name: 'a decision is announced twice',
    mutate: { notifier: (n, w) => custom(w, (row) => [decisionBody(row), decisionBody(row)]) },
    expect: ['notify.decision-is-announced']
  },
  {
    name: 'the signature headers are left out although the manifest says signed',
    mutate: { notifier: (n, w) => ({ ...custom(w, decisionBody, { secret: '' }), signed: true }) },
    expect: ['notify.signature-verifies']
  },
  {
    name: 'the signature is made with another secret',
    mutate: { notifier: (n, w) => custom(w, decisionBody, { secret: w.secret + '-other' }) },
    expect: ['notify.signature-verifies']
  },
  {
    name: 'a submit is announced',
    mutate: {
      service: (svc, store, w) => ({ ...svc, submit: async (body) => {
        const row = await svc.submit(body);
        await sendBody(w, decisionBody({ ...row, status: 'Approved', decidedUtc: new Date().toISOString() }));
        return row;
      } })
    },
    expect: ['notify.only-for-stored-decisions']
  },
  {
    name: 'a refused decision is announced',
    mutate: {
      service: (svc, store, w) => ({ ...svc, decide: async (id, verb, input) => {
        try { return await svc.decide(id, verb, input); } catch (err) {
          await sendBody(w, decisionBody({ approvalId: Number(id), status: 'Rejected', decidedUtc: new Date().toISOString() }));
          throw err;
        }
      } })
    },
    expect: ['notify.only-for-stored-decisions']
  },
  {
    name: 'a receiver that fails makes the decision fail (the notification is part of the decision)',
    mutate: {
      notifier: (n) => muted(n),
      service: (svc, store, w) => ({ ...svc, decide: async (id, verb, input) => {
        const row = await svc.decide(id, verb, input);
        const res = await sendBody(w, decisionBody(row));
        if (!res || res.status >= 400) throw new Error('the receiver could not be told');
        return row;
      } })
    },
    expect: ['notify.receiver-failure-is-harmless']
  },
  {
    name: 'the reviewer waits for the receiver (the notification is sent before the answer)',
    mutate: {
      notifier: (n) => muted(n),
      service: (svc, store, w) => ({ ...svc, decide: async (id, verb, input) => {
        const row = await svc.decide(id, verb, input);
        await sendBody(w, decisionBody(row));
        return row;
      } })
    },
    expect: ['notify.slow-receiver-does-not-delay-decisions'],
    conformant: true // a SHOULD check: a stack that cannot detach may wait for the 3 s time-out
  },
  {
    name: 'a redirect from the receiver is followed',
    mutate: { notifier: (n, w) => through(w, (url, init) => fetch(url, { ...init, redirect: 'follow' })) },
    expect: ['notify.redirects-are-not-followed'],
    conformant: true
  },
  {
    name: 'a failed delivery is retried',
    mutate: { notifier: (n, w) => through(w, async (url, init) => {
      const first = await fetch(url, init);
      return first.status >= 500 ? fetch(url, init) : first;
    }) },
    expect: ['notify.no-retry'],
    conformant: true
  },
  {
    name: 'the manifest does not mention notifications',
    mutate: { service: (svc) => ({ ...svc, notifications: null }) },
    expect: ['notify.manifest-says-so'],
    conformant: true
  }
];

// All of them at once: they are independent servers on their own ports, and each waits mostly on timers.
const notifyRuns = NOTIFY_MUTANTS.map((m) => {
  const run = runAgainst(m.mutate, { notify: true, only: 'notify.' });
  run.catch(() => {});
  return run;
});

NOTIFY_MUTANTS.forEach((mutant, i) => {
  test(`suite catches a faulty notifier: ${mutant.name}`, async () => {
    const run = await notifyRuns[i];
    assert.equal(run.summary.conformant, mutant.conformant ?? false, mutant.conformant ? 'only a SHOULD check is expected to fail' : 'a broken sender must not be reported as conformant');
    const failed = failedIds(run);
    for (const id of mutant.expect) assert.ok(failed.includes(id), `expected ${id} to fail; failed: ${failed.join(', ')}`);
  });
});
