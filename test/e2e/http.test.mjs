/** Full HTTP loop against an in-process demo app on a random port. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createDemoApp } from '../../demo-cms/server.mjs';

const require = createRequire(import.meta.url);
const { createAgentClient, createReviewClient } = require('../../src/client.js');

let app; let baseUrl; let origin; let agent; let review;

test.before(async () => {
  app = createDemoApp();
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  origin = 'http://127.0.0.1:' + app.server.address().port;
  baseUrl = origin + '/api/seo';
  agent = createAgentClient({ baseUrl, writeKey: 'demo-write' });
  review = createReviewClient({ baseUrl, session: 'demo-manager' });
});
test.after(() => new Promise((r) => app.server.close(r)));

const body = (extra) => ({
  siteId: 1, resourceType: 'article', resourceId: 42, action: 'update:canonical',
  scope: 'seo:write', reason: 'e2e', proposal: { canonical: 'https://example.com/e2e' }, ...extra
});
const writeOf = (row) => ({
  approvalId: row.approvalId, resourceType: row.resourceType, resourceId: row.resourceId,
  action: row.action, scope: row.scope, proposal: row.proposal
});
const raw = (method, path, headers, payload) => fetch(baseUrl + path, {
  method, headers: { 'Content-Type': 'application/json', ...headers }, body: payload === undefined ? undefined : payload
});

test('agent reads a resource, proposes, waits, then the CMS really changes', async () => {
  const before = await agent.readResource('article', 42);
  assert.equal(before.canonical, '');

  const row = await agent.submit(body());
  assert.equal((await agent.readResource('article', 42)).canonical, '', 'no write before approval');

  await review.approve(row.approvalId);
  const done = await agent.execute(writeOf(row));
  assert.equal(done.status, 'Consumed');
  assert.equal((await agent.readResource('article', 42)).canonical, 'https://example.com/e2e');
});

test('reviewer edits the payload and the CMS gets the edited value', async () => {
  const row = await agent.submit(body({ proposal: { canonical: 'https://example.com/draft' } }));
  const edited = { canonical: 'https://example.com/final' };
  const approved = await review.approve(row.approvalId, '', edited);
  assert.equal(approved.editedProposal, true);

  await assert.rejects(() => agent.execute(writeOf(row)), (e) => e.code === 'APPROVAL_PAYLOAD_MISMATCH');
  await agent.execute(writeOf(approved));
  assert.equal((await agent.readResource('article', 42)).canonical, 'https://example.com/final');
});

test('missing resource is a 404, unauthenticated read is a 401', async () => {
  await assert.rejects(() => agent.readResource('article', 777), (e) => e.code === 'NOT_FOUND' && e.http === 404);
  const res = await raw('GET', '/resources/article/42', {});
  assert.equal(res.status, 401);
});

test('malformed JSON and oversized bodies fail cleanly', async () => {
  const bad = await raw('POST', '/proposals', { 'X-Api-Key': 'demo-write' }, '{nope');
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error.code, 'BAD_REQUEST');
  const huge = await raw('POST', '/proposals', { 'X-Api-Key': 'demo-write' }, JSON.stringify({ x: 'a'.repeat(300000) }));
  assert.equal(huge.status, 413);
});

test('unknown routes and wrong keys', async () => {
  assert.equal((await raw('GET', '/nope', {})).status, 404);
  const wrong = await raw('POST', '/proposals', { 'X-Api-Key': 'demo-wri' }, JSON.stringify(body()));
  assert.equal(wrong.status, 403);
});

test('manifest advertises the profile so an agent can discover actions', async () => {
  const m = await agent.manifest();
  assert.ok(m.actions.includes('update:canonical'));
  assert.ok(m.scopes.includes('seo:write'));
  assert.equal(m.limits.maxFields, 40);
});

test('handler passes unrelated paths through to next()', async () => {
  const { createHttpHandler, apiKeyAgentDoor, headerReviewerDoor, SEO_PROFILE } = await import('../../src/server/index.mjs');
  const handler = createHttpHandler({
    service: app.service, profile: SEO_PROFILE, basePath: '/api/x',
    doors: { agent: apiKeyAgentDoor({}), reviewer: headerReviewerDoor({ sessions: {} }) }
  });
  let called = false;
  await handler({ url: '/other', method: 'GET', headers: {} }, {}, () => { called = true; });
  assert.ok(called);
});
