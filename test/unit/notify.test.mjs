import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHmac } from 'node:crypto';
import { createRequire } from 'node:module';
import {
  createApprovalService, createMemoryStore, createMemoryCms, createWebhookNotifier, decisionBody, signDelivery, SEO_PROFILE
} from '../../src/server/index.mjs';

const require = createRequire(import.meta.url);
const { createReceiver, verifyDelivery, parseDecision } = require('../../src/receiver.js');
const { createAgentClient } = require('../../src/client.js');

const quiet = () => { const lines = []; return { lines, warn: (m) => lines.push(m) }; };
const ROW = { approvalId: 1042, status: 'Approved', decidedUtc: '2026-10-16T01:40:12.345Z', proposal: { secret: 'must not leak' } };

/** A local server that records what it is sent. `behave(req, res)` decides the answer. */
async function listener(behave = (req, res) => { res.writeHead(204); res.end(); }) {
  const hits = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => { hits.push({ method: req.method, url: req.url, headers: req.headers, raw: Buffer.concat(chunks).toString('utf8') }); behave(req, res); });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { hits, url: 'http://127.0.0.1:' + server.address().port + '/hook', close: () => { server.closeAllConnections(); return new Promise((r) => server.close(r)); } };
}

test('the body is compact JSON with four fields in a fixed order, and nothing from the proposal', () => {
  assert.equal(decisionBody(ROW), '{"event":"decision","approvalId":1042,"status":"Approved","decidedUtc":"2026-10-16T01:40:12.345Z"}');
});

test('the signature is sha256 over "<timestamp>.<raw body>" (checked against an independent HMAC)', () => {
  const body = decisionBody(ROW);
  const independent = 'sha256=' + createHmac('sha256', 'shh').update('1760579000.' + body).digest('hex');
  assert.equal(signDelivery('shh', '1760579000', body), independent);
});

test('the signature matches the test vector published in docs/spec.md', () => {
  const body = decisionBody(ROW);
  assert.equal(body, '{"event":"decision","approvalId":1042,"status":"Approved","decidedUtc":"2026-10-16T01:40:12.345Z"}');
  assert.equal(signDelivery('s3cret', '1760580012', body), 'sha256=8bd76bf7597eacb8a5c71c7b0485d267471f99bd208bc604aa570511a236f684');
});

test('a bad receiver url is refused at start-up, not at the first decision', () => {
  for (const url of ['not a url', 'ftp://example.com/x', 'file:///etc/passwd', 'http://user:pw@example.com/x', '']) {
    assert.throws(() => createWebhookNotifier({ url }), TypeError, url);
  }
});

test('the notifier posts one signed delivery that the agent-side verifier accepts', async () => {
  const rx = await listener();
  try {
    const now = () => 1760579000_000;
    await createWebhookNotifier({ url: rx.url, secret: 'shh', now, logger: quiet() }).decided(ROW);
    assert.equal(rx.hits.length, 1);
    const [hit] = rx.hits;
    assert.equal(hit.method, 'POST');
    assert.match(hit.headers['content-type'], /^application\/json/);
    assert.match(hit.headers['x-hermes-delivery'], /^[0-9a-f-]{36}$/);
    assert.equal(hit.headers['x-hermes-timestamp'], '1760579000');
    assert.equal(hit.raw, decisionBody(ROW));
    assert.deepEqual(verifyDelivery({ secret: 'shh', headers: hit.headers, rawBody: hit.raw, now }), { ok: true, signed: true });
    assert.equal(verifyDelivery({ secret: 'other', headers: hit.headers, rawBody: hit.raw, now }).ok, false);
    assert.equal(verifyDelivery({ secret: 'shh', headers: hit.headers, rawBody: hit.raw + ' ', now }).ok, false, 'a changed body');
    assert.equal(verifyDelivery({ secret: 'shh', headers: hit.headers, rawBody: hit.raw, now: () => now() + 301_000 }).ok, false, 'a replay after five minutes');
  } finally { await rx.close(); }
});

test('without a secret the delivery is unsigned and says so in the manifest note', async () => {
  const rx = await listener();
  try {
    const notifier = createWebhookNotifier({ url: rx.url, logger: quiet() });
    assert.equal(notifier.signed, false);
    await notifier.decided(ROW);
    assert.equal(rx.hits[0].headers['x-hermes-signature'], undefined);
    assert.equal(rx.hits[0].headers['x-hermes-timestamp'], undefined);
    assert.deepEqual(verifyDelivery({ secret: '', headers: rx.hits[0].headers, rawBody: rx.hits[0].raw }), { ok: true, signed: false });
  } finally { await rx.close(); }
});

test('redirects are not followed', async () => {
  const target = await listener();
  const bouncer = await listener((req, res) => { res.writeHead(302, { Location: target.url }); res.end(); });
  try {
    await createWebhookNotifier({ url: bouncer.url, logger: quiet() }).decided(ROW);
    assert.equal(bouncer.hits.length, 1);
    assert.equal(target.hits.length, 0, 'the redirect target must never be called');
  } finally { await bouncer.close(); await target.close(); }
});

test('a receiver that is down, broken or hanging is logged and never throws', async () => {
  const log = quiet();
  const dead = await listener();
  const deadUrl = dead.url;
  await dead.close();
  await createWebhookNotifier({ url: deadUrl, logger: log }).decided(ROW);
  assert.match(log.lines.at(-1), /HRM-1042: not delivered/);

  const broken = await listener((req, res) => { res.writeHead(500); res.end('no'); });
  await createWebhookNotifier({ url: broken.url, logger: log }).decided(ROW);
  assert.match(log.lines.at(-1), /answered 500/);
  await broken.close();

  const hung = await listener(() => { /* never answers */ });
  const started = Date.now();
  await createWebhookNotifier({ url: hung.url, timeoutMs: 150, logger: log }).decided(ROW);
  assert.ok(Date.now() - started < 1500, 'gives up at the timeout');
  assert.match(log.lines.at(-1), /not delivered/);
  await hung.close();

  await createWebhookNotifier({ url: deadUrl, logger: { warn() { throw new Error('logger is broken'); } } }).decided(ROW); // still does not throw
});

// ---------------------------------------------------------------- the service

const proposal = () => ({
  siteId: 1, resourceType: 'article', resourceId: 42, action: 'update:canonical',
  scope: 'seo:write', reason: 'r', proposal: { canonical: 'https://example.com/a' }
});
const REVIEWER = { id: 'manager.test' };
function serviceWith(notifier) {
  const cms = createMemoryCms({ resources: [{ resourceType: 'article', resourceId: 42, fields: { canonical: '' } }] });
  return createApprovalService({ store: createMemoryStore(), cms, profile: SEO_PROFILE, notifier });
}
const recorder = () => { const calls = []; return { calls, decided: (row) => { calls.push({ id: row.approvalId, status: row.status, decidedUtc: row.decidedUtc }); } }; };
const tick = () => new Promise((r) => setImmediate(r));

test('the service announces each stored decision once, with the stored row', async () => {
  const notifier = recorder();
  const service = serviceWith(notifier);
  const a = await service.submit(proposal());
  const b = await service.submit(proposal());
  const c = await service.submit(proposal());
  assert.deepEqual(notifier.calls, [], 'a submit is not announced');

  const approved = await service.decide(a.approvalId, 'approve', { reviewer: REVIEWER });
  await service.decide(b.approvalId, 'reject', { reviewer: REVIEWER, reason: 'no' });
  await service.decide(c.approvalId, 'request-changes', { reviewer: REVIEWER, reason: 'fix' });
  assert.deepEqual(notifier.calls.map((x) => x.status), ['Approved', 'Rejected', 'ChangesRequested']);
  assert.equal(notifier.calls[0].decidedUtc, approved.decidedUtc);

  await service.execute({ approvalId: approved.approvalId, resourceType: 'article', resourceId: 42, action: 'update:canonical', scope: 'seo:write', proposal: approved.proposal });
  assert.equal(notifier.calls.length, 3, 'a write is not announced');
});

test('a refused decision is not announced', async () => {
  const notifier = recorder();
  const service = serviceWith(notifier);
  const a = await service.submit(proposal());
  await assert.rejects(() => service.decide(a.approvalId, 'reject', { reviewer: REVIEWER, reason: ' ' }), (e) => e.code === 'DECISION_REASON_REQUIRED');
  await assert.rejects(() => service.decide(a.approvalId, 'approve', {}), (e) => e.code === 'SCOPE_DENIED');
  await service.decide(a.approvalId, 'approve', { reviewer: REVIEWER });
  await assert.rejects(() => service.decide(a.approvalId, 'reject', { reviewer: REVIEWER, reason: 'late' }), (e) => e.code === 'APPROVAL_NOT_PENDING');
  assert.equal(notifier.calls.length, 1);
});

test('a notifier that throws, rejects or never finishes cannot undo, fail or delay a decision', async () => {
  const bad = [
    { decided() { throw new Error('sync failure'); } },
    { decided: async () => { throw new Error('async failure'); } },
    { decided: () => new Promise(() => { /* never settles */ }) }
  ];
  for (const notifier of bad) {
    const service = serviceWith(notifier);
    const row = await service.submit(proposal());
    const started = Date.now();
    const decided = await service.decide(row.approvalId, 'approve', { reviewer: REVIEWER });
    assert.equal(decided.status, 'Approved');
    assert.ok(Date.now() - started < 500);
    await tick();
    assert.equal((await service.get(row.approvalId)).status, 'Approved');
  }
});

test('the manifest note: nothing without a notifier, decision + signed with one', () => {
  assert.equal(serviceWith(null).notifications, null);
  assert.deepEqual(serviceWith(createWebhookNotifier({ url: 'http://127.0.0.1:9/x', logger: quiet() })).notifications, { decision: true, signed: false });
  assert.deepEqual(serviceWith(createWebhookNotifier({ url: 'http://127.0.0.1:9/x', secret: 's', logger: quiet() })).notifications, { decision: true, signed: true });
});

// ---------------------------------------------------------------- the agent side

async function post(url, body, headers = { 'content-type': 'application/json' }, method = 'POST') {
  const res = await fetch(url, { method, headers, body });
  await res.arrayBuffer();
  return res.status;
}

test('the receiver hands a verified nudge to onDecision, answers first, and counts a repeated delivery once', async () => {
  const seen = [];
  const rx = await createReceiver({ secret: 'shh', logger: quiet(), onDecision: (d, meta) => { seen.push({ d, meta }); } });
  try {
    const sender = createWebhookNotifier({ url: rx.url, secret: 'shh', logger: quiet() });
    await sender.decided(ROW);
    await sender.decided({ ...ROW, approvalId: 7, status: 'Rejected' });
    await tick(); await tick();
    assert.deepEqual(seen.map((s) => [s.d.approvalId, s.d.status, s.meta.signed]), [[1042, 'Approved', true], [7, 'Rejected', true]]);

    const body = decisionBody(ROW);
    const ts = String(Math.floor(Date.now() / 1000));
    const headers = { 'content-type': 'application/json', 'x-hermes-timestamp': ts, 'x-hermes-signature': 'sha256=' + createHmac('sha256', 'shh').update(ts + '.' + body).digest('hex'), 'x-hermes-delivery': 'same-id' };
    assert.equal(await post(rx.url, body, headers), 204);
    assert.equal(await post(rx.url, body, headers), 204);
    await tick(); await tick();
    assert.equal(seen.length, 3, 'the same delivery id is handed over once');
  } finally { await rx.close(); }
});

test('the receiver refuses what it should: bad signature, wrong path, wrong method, too big, not a decision', async () => {
  const seen = [];
  const rx = await createReceiver({ secret: 'shh', logger: quiet(), onDecision: (d) => seen.push(d) });
  try {
    const body = decisionBody(ROW);
    const json = { 'content-type': 'application/json' };
    assert.equal(await post(rx.url, body, json), 401, 'unsigned while a secret is set');
    assert.equal(await post(rx.url, body, { ...json, 'x-hermes-timestamp': String(Math.floor(Date.now() / 1000)), 'x-hermes-signature': 'sha256=' + '0'.repeat(64) }), 401);
    assert.equal(await post(rx.url.replace('/hook', '/elsewhere'), body, json), 404);
    assert.equal(await post(rx.url, undefined, {}, 'GET'), 405);
    assert.equal(await post(rx.url, 'x'.repeat(5000), json), 413);
    await tick();
    assert.deepEqual(seen, []);
  } finally { await rx.close(); }

  const open = await createReceiver({ logger: quiet(), onDecision: (d) => seen.push(d) });
  try {
    assert.equal(await post(open.url, '{"event":"decision"}', { 'content-type': 'application/json' }), 400, 'missing fields');
    assert.equal(await post(open.url, '{"event":"other","approvalId":1,"status":"Approved","decidedUtc":"x"}', { 'content-type': 'application/json' }), 400, 'unknown event');
    assert.equal(await post(open.url, 'not json', { 'content-type': 'application/json' }), 400);
    assert.equal(await post(open.url, decisionBody(ROW), { 'content-type': 'application/json' }), 204, 'an unsigned receiver accepts an unsigned nudge');
    await tick(); await tick();
    assert.equal(seen.length, 1);
  } finally { await open.close(); }
});

test('parseDecision accepts exactly the three decision states', () => {
  for (const status of ['Approved', 'Rejected', 'ChangesRequested']) assert.ok(parseDecision(JSON.stringify({ event: 'decision', approvalId: 1, status, decidedUtc: 'x' })));
  for (const status of ['Pending', 'Consumed', 'Expired', 'approved', 1, null]) assert.equal(parseDecision(JSON.stringify({ event: 'decision', approvalId: 1, status, decidedUtc: 'x' })), null, String(status));
  assert.equal(parseDecision(JSON.stringify({ event: 'decision', approvalId: '1', status: 'Approved', decidedUtc: 'x' })), null, 'approvalId must be a number');
});

// ---------------------------------------------------------------- waitForDecision

async function withFetch(statuses, run) {
  const real = globalThis.fetch;
  let i = 0;
  globalThis.fetch = async () => {
    const status = statuses[Math.min(i, statuses.length - 1)];
    i += 1;
    return new Response(JSON.stringify({ success: true, data: { approvalId: 5, status } }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try { return await run(() => i); } finally { globalThis.fetch = real; }
}
const agent = () => createAgentClient({ baseUrl: 'http://cms.test/api', writeKey: 'k' });

test('waitForDecision: a request that was decided before the first look is returned at once', async () => {
  await withFetch(['Approved'], async (reads) => {
    const row = await agent().waitForDecision(5, { intervalMs: 10, timeoutMs: 1000 });
    assert.equal(row.status, 'Approved');
    assert.equal(reads(), 1, 'one read, no waiting');
  });
});

test('waitForDecision: waits while Pending, then returns whatever was decided', async () => {
  await withFetch(['Pending', 'Pending', 'ChangesRequested'], async (reads) => {
    const row = await agent().waitForDecision(5, { intervalMs: 5, timeoutMs: 2000 });
    assert.equal(row.status, 'ChangesRequested');
    assert.equal(reads(), 3);
  });
});

test('waitForDecision: gives up with WAIT_TIMEOUT while still Pending', async () => {
  await withFetch(['Pending'], async () => {
    await assert.rejects(() => agent().waitForDecision(5, { intervalMs: 5, timeoutMs: 40 }), (e) => e.code === 'WAIT_TIMEOUT');
  });
});
