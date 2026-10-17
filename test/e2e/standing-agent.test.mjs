/** A standing agent against the real demo CMS: the write must follow the decision by itself, with the poll switched off. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { createRequire } from 'node:module';
import { createDemoApp } from '../../demo-cms/server.mjs';

const require = createRequire(import.meta.url);
const { createAgentClient, createReviewClient } = require('../../src/client.js');
const { createStandingAgent, MAX_ATTEMPTS } = require('../../src/standing-agent.js');

const quiet = () => { const lines = []; return { lines, log: (m) => lines.push(m), warn: (m) => lines.push('WARN ' + m) }; };
const until = async (fn, ms = 3000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 20)); }
  throw new Error('timed out');
};
const proposal = (extra) => ({
  siteId: 1, resourceType: 'article', resourceId: 42, action: 'update:canonical', scope: 'seo:write',
  reason: 'standing agent test', proposal: { canonical: 'https://example.com/standing' }, ...extra
});

async function freePort() {
  const probe = net.createServer();
  await new Promise((r) => probe.listen(0, '127.0.0.1', r));
  const { port } = probe.address();
  await new Promise((r) => probe.close(r));
  return port;
}

/** A demo CMS that announces decisions to a standing agent listening on a port picked beforehand. */
async function rig(options) {
  // A probed port can be taken by another server starting in parallel before the agent listens on it: try a new one.
  for (let attempt = 1; ; attempt += 1) {
    try { return await rigOnce(options); }
    catch (err) { if (err.code !== 'EADDRINUSE' || attempt >= 5) throw err; }
  }
}

async function rigOnce({ secret = 'shh', agentSecret = secret, stateFile = '', logger = quiet() } = {}) {
  const outcomes = [];
  const port = await freePort();
  const app = createDemoApp({ webhook: { url: 'http://127.0.0.1:' + port + '/hook', secret, logger: quiet() } });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const baseUrl = 'http://127.0.0.1:' + app.server.address().port + '/api/seo';
  const agent = createAgentClient({ baseUrl, writeKey: 'demo-write' });
  const review = createReviewClient({ baseUrl, session: 'demo-manager' });
  const standing = createStandingAgent({
    agent, receiver: { port, secret: agentSecret }, stateFile, pollMs: 3_600_000, logger, // the poll is effectively off
    onOutcome: (o) => outcomes.push(o)
  });
  try { await standing.start(); } catch (err) { await new Promise((r) => app.server.close(r)); throw err; }
  return { app, agent, review, standing, logger, outcomes, close: async () => { await standing.stop(); await new Promise((r) => app.server.close(r)); } };
}

test('an approval is redeemed by the standing agent by itself, the moment it is decided', async () => {
  const t = await rig();
  try {
    const row = await t.standing.submit(proposal());
    assert.equal((await t.agent.readResource('article', 42)).canonical, '', 'nothing is written before a person decides');
    await t.review.approve(row.approvalId);
    await until(async () => (await t.agent.readResource('article', 42)).canonical === 'https://example.com/standing');
    await until(() => t.outcomes.length === 1);
    assert.equal(t.outcomes[0].status, 'Consumed');
    assert.deepEqual(t.standing.open(), []);
    assert.equal((await t.agent.get(row.approvalId)).status, 'Consumed');
  } finally { await t.close(); }
});

test('it writes the reviewer\'s edited version, not the agent\'s own', async () => {
  const t = await rig();
  try {
    const row = await t.standing.submit(proposal({ proposal: { canonical: 'https://example.com/draft' } }));
    await t.review.approve(row.approvalId, '', { canonical: 'https://example.com/final' });
    await until(async () => (await t.agent.readResource('article', 42)).canonical === 'https://example.com/final');
  } finally { await t.close(); }
});

test('a rejection and a change request are reported and nothing is written', async () => {
  const t = await rig();
  try {
    const a = await t.standing.submit(proposal());
    const b = await t.standing.submit(proposal({ resourceType: 'page', resourceId: 88, proposal: { titleSeo: 'Never written' } }));
    await t.review.reject(a.approvalId, 'not this one');
    await t.review.requestChanges(b.approvalId, 'shorter please');
    await until(() => t.outcomes.length === 2);
    assert.deepEqual(t.outcomes.map((o) => o.status).sort(), ['ChangesRequested', 'Rejected']);
    assert.equal((await t.agent.readResource('article', 42)).canonical, '');
    assert.equal((await t.agent.readResource('page', 88)).titleSeo, 'Old title');
  } finally { await t.close(); }
});

test('a decision about a request it did not file is ignored', async () => {
  const t = await rig();
  try {
    const other = await t.agent.submit(proposal()); // filed behind the standing agent\'s back
    await t.review.approve(other.approvalId);
    await until(() => t.logger.lines.some((l) => l.includes('was not filed by this agent')));
    assert.equal((await t.agent.get(other.approvalId)).status, 'Approved', 'left for whoever filed it');
    assert.equal((await t.agent.readResource('article', 42)).canonical, '');
  } finally { await t.close(); }
});

test('an unsigned or wrongly signed nudge is refused and nothing is redeemed by it', async () => {
  const t = await rig({ secret: 'cms-secret', agentSecret: 'other-secret' });
  try {
    const row = await t.standing.submit(proposal());
    await t.review.approve(row.approvalId);
    await until(() => t.logger.lines.some((l) => l.includes('refused a notification')));
    assert.equal((await t.agent.get(row.approvalId)).status, 'Approved');
    // the safety-net sweep still gets there: a lost or refused nudge delays the write, it does not lose it
    await t.standing.sweep();
    assert.equal((await t.agent.get(row.approvalId)).status, 'Consumed');
  } finally { await t.close(); }
});

test('a decision made while the agent was not running is found by the start-up sweep', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'standing-'));
  const stateFile = path.join(dir, 'state.json');
  const t = await rig({ stateFile });
  try {
    const row = await t.standing.submit(proposal());
    await t.standing.stop(); // the agent goes away; the person decides meanwhile
    await t.review.approve(row.approvalId);
    assert.equal((await t.agent.get(row.approvalId)).status, 'Approved');
    const again = createStandingAgent({ agent: t.agent, receiver: { port: 0 }, stateFile, pollMs: 3_600_000, logger: quiet(), onOutcome: (o) => t.outcomes.push(o) });
    await again.start();
    try {
      await until(() => t.outcomes.some((o) => o.status === 'Consumed'));
      assert.equal((await t.agent.readResource('article', 42)).canonical, 'https://example.com/standing');
      assert.deepEqual(JSON.parse(fs.readFileSync(stateFile, 'utf8')).open, []);
    } finally { await again.stop(); }
  } finally { await t.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a nudge and the poll at the same moment redeem a row once', async () => {
  const t = await rig();
  try {
    const row = await t.standing.submit(proposal());
    await t.review.approve(row.approvalId);
    await Promise.all([t.standing.sweep(), t.standing.sweep(), t.standing.sweep()]);
    await until(() => t.outcomes.length >= 1);
    assert.equal(t.outcomes.filter((o) => o.status === 'Consumed').length, 1);
    assert.ok(!t.logger.lines.some((l) => l.startsWith('WARN')), 'no failed second redeem: ' + t.logger.lines.join(' | '));
  } finally { await t.close(); }
});

test('a write that keeps failing is reported after a few tries, not retried forever', async () => {
  const lines = quiet();
  let calls = 0;
  const row = { approvalId: 7, status: 'Approved', resourceType: 'article', resourceId: 42, action: 'update:canonical', scope: 'seo:write', proposal: {} };
  const agent = { get: async () => row, execute: async () => { calls += 1; throw Object.assign(new Error('boom'), { code: 'WRITE_FAILED' }); }, submit: async () => row };
  const outcomes = [];
  const standing = createStandingAgent({ agent, receiver: { port: 0 }, pollMs: 3_600_000, logger: lines, onOutcome: (o) => outcomes.push(o) });
  standing.track(7);
  await standing.start();
  try {
    for (let i = 0; i < MAX_ATTEMPTS + 2; i += 1) await standing.sweep();
    await until(() => outcomes.length === 1);
    assert.equal(calls, MAX_ATTEMPTS);
    assert.equal(outcomes[0].status, 'ExecutionFailed');
    assert.equal(outcomes[0].error.code, 'WRITE_FAILED');
  } finally { await standing.stop(); }
});
