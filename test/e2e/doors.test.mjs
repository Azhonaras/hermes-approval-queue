/**
 * Door and bind tests for the demo CMS. Node 18+ (node --test).
 * Starts its own server. Dummy keys only.
 */
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createAgentClient, createReviewClient } = require('../../src/client.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.TEST_PORT || 8799);
const baseUrl = 'http://127.0.0.1:' + PORT + '/api/seo';
const WRITE = { 'X-Api-Key': 'demo-write', 'Content-Type': 'application/json' };
const READ = { 'X-Api-Key': 'demo-read' };
const REVIEW = { 'X-Review-Session': 'demo-manager', 'Content-Type': 'application/json' };

let child;
const agent = createAgentClient({ baseUrl, writeKey: 'demo-write' });
const review = createReviewClient({ baseUrl, session: 'demo-manager' });

async function json(method, urlPath, headers, body) {
  const res = await fetch(baseUrl + urlPath, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return { http: res.status, json: await res.json() };
}

function proposal(extra) {
  return Object.assign({
    siteId: 1,
    resourceType: 'article',
    resourceId: 9001,
    action: 'update:canonical',
    scope: 'seo:write',
    reason: 'test',
    proposal: { canonical: 'https://example.com/test-guide' }
  }, extra);
}

test.before(async () => {
  child = spawn(process.execPath, [path.join(__dirname, '..', '..', 'demo-cms', 'server.mjs')], {
    env: Object.assign({}, process.env, { PORT: String(PORT) }),
    cwd: path.join(__dirname, '..', '..', 'demo-cms'),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let buf = '';
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('demo CMS did not start')), 8000);
    child.stderr.on('data', (c) => { buf += c; });
    child.stdout.on('data', (c) => {
      buf += c;
      if (buf.includes('/api/seo')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code) reject(new Error('server exited ' + code + '\n' + buf));
    });
  });
});

test.after(async () => {
  if (!child || child.killed) return;
  child.kill();
  await once(child, 'exit').catch(() => {});
});

test('ping is open; manifest needs a door', async () => {
  const ping = await json('GET', '/ping', {});
  assert.equal(ping.json.success, true);
  const denied = await json('GET', '/manifest', {});
  assert.equal(denied.http, 401);
  assert.equal(denied.json.error.code, 'UNAUTHORIZED');
});

test('write key cannot list or approve', async () => {
  const listed = await json('GET', '/proposals?status=pending', WRITE);
  assert.equal(listed.http, 403);
  assert.equal(listed.json.error.code, 'SCOPE_DENIED');

  const row = await agent.submit(proposal({ resourceId: 9101 }));
  const both = await json('POST', '/proposals/' + row.approvalId + '/approve', {
    'X-Api-Key': 'demo-write',
    'X-Review-Session': 'demo-manager',
    'Content-Type': 'application/json'
  }, {});
  assert.equal(both.http, 403);
  assert.equal(both.json.error.code, 'SCOPE_DENIED');

  const onlyWrite = await json('POST', '/proposals/' + row.approvalId + '/approve', WRITE, {});
  assert.equal(onlyWrite.http, 403);
});

test('read key cannot submit or write', async () => {
  const readAgent = createAgentClient({ baseUrl, readKey: 'demo-read' });
  await assert.rejects(() => readAgent.submit(proposal({ resourceId: 9102 })), (err) => {
    assert.equal(err.code, 'SCOPE_DENIED');
    return true;
  });
  const write = await json('POST', '/writes', READ, { approvalId: 1 });
  assert.equal(write.http, 403);
});

test('review session cannot submit or execute', async () => {
  const submit = await json('POST', '/proposals', REVIEW, proposal({ resourceId: 9103 }));
  assert.equal(submit.http, 403);
  const exe = await json('POST', '/writes', REVIEW, { approvalId: 1042 });
  assert.equal(exe.http, 403);
});

test('write is blocked until approve; payload and action are bound; consume once', async () => {
  const row = await agent.submit(proposal({
    resourceId: 9104,
    proposal: { canonical: 'https://example.com/bound' }
  }));

  await assert.rejects(() => agent.execute({
    approvalId: row.approvalId,
    resourceType: row.resourceType,
    resourceId: row.resourceId,
    action: row.action,
    scope: row.scope,
    proposal: row.proposal
  }), (err) => err.code === 'APPROVAL_PENDING');

  const approved = await review.approve(row.approvalId);
  assert.equal(approved.status, 'Approved');
  assert.equal(approved.decidedBy, 'manager.demo');

  await assert.rejects(() => agent.execute({
    approvalId: row.approvalId,
    resourceType: row.resourceType,
    resourceId: row.resourceId,
    action: 'update:redirect',
    scope: row.scope,
    proposal: row.proposal
  }), (err) => err.code === 'APPROVAL_MISMATCH');

  await assert.rejects(() => agent.execute({
    approvalId: row.approvalId,
    resourceType: row.resourceType,
    resourceId: row.resourceId,
    action: row.action,
    scope: row.scope,
    proposal: { canonical: 'https://evil.example/' }
  }), (err) => err.code === 'APPROVAL_PAYLOAD_MISMATCH');

  const written = await agent.execute({
    approvalId: row.approvalId,
    resourceType: row.resourceType,
    resourceId: row.resourceId,
    action: row.action,
    scope: row.scope,
    proposal: { canonical: 'https://example.com/bound' }
  });
  assert.equal(written.status, 'Consumed');

  await assert.rejects(() => agent.execute({
    approvalId: row.approvalId,
    resourceType: row.resourceType,
    resourceId: row.resourceId,
    action: row.action,
    scope: row.scope,
    proposal: row.proposal
  }), (err) => err.code === 'APPROVAL_NOT_USABLE');
});

test('reject and request-changes require a reason; parent stays ChangesRequested', async () => {
  const a = await agent.submit(proposal({ resourceId: 9105 }));
  const noReason = await json('POST', '/proposals/' + a.approvalId + '/reject', REVIEW, { reason: '' });
  assert.equal(noReason.http, 400);
  assert.equal(noReason.json.error.code, 'DECISION_REASON_REQUIRED');

  const b = await agent.submit(proposal({ resourceId: 9106 }));
  const parent = await review.requestChanges(b.approvalId, 'Shorten the title.');
  assert.equal(parent.status, 'ChangesRequested');

  const revision = await agent.submit(proposal({
    resourceId: 9106,
    proposal: { canonical: 'https://example.com/revised' },
    revisionOfApprovalId: parent.approvalId
  }));
  assert.ok(revision.approvalId !== parent.approvalId);
  assert.equal(revision.revisionOfApprovalId, parent.approvalId);
  const still = await agent.get(parent.approvalId);
  assert.equal(still.status, 'ChangesRequested');
});

test('vague update is refused; unknown list status is refused', async () => {
  const vague = await json('POST', '/proposals', WRITE, proposal({ action: 'update' }));
  assert.equal(vague.http, 400);
  const dump = await json('GET', '/proposals?status=all', REVIEW);
  assert.equal(dump.http, 400);
});

test('expired approval returns the documented error code', async () => {
  const result = await json('POST', '/writes', WRITE, {
    approvalId: 1036,
    resourceType: 'page',
    resourceId: 77,
    action: 'update:onpage',
    scope: 'seo:write',
    proposal: { titleSeo: 'Expired sample' }
  });
  assert.equal(result.http, 409);
  assert.equal(result.json.error.code, 'APPROVAL_EXPIRED');
});

test('proposal requires a resource identity and a JSON object payload', async () => {
  const cases = [
    proposal({ resourceType: '' }),
    proposal({ resourceId: null }),
    proposal({ proposal: ['not', 'an', 'object'] }),
    proposal({ proposal: 'not an object' })
  ];

  for (const body of cases) {
    const result = await json('POST', '/proposals', WRITE, body);
    assert.equal(result.http, 400);
    assert.equal(result.json.error.code, 'BAD_REQUEST');
  }
});

test('revision keeps the parent site, resource, action, and scope', async () => {
  const original = await agent.submit(proposal({
    siteId: 7,
    resourceId: 9107,
    action: 'update:onpage',
    proposal: { titleSeo: 'Original title' }
  }));
  await review.requestChanges(original.approvalId, 'Revise the title.');

  const mismatches = [
    { siteId: 8 },
    { resourceType: 'product' },
    { resourceId: 9999 },
    { action: 'update:redirect' },
    { scope: 'content:update' }
  ];
  for (const mismatch of mismatches) {
    const result = await json('POST', '/proposals', WRITE, proposal({
      siteId: original.siteId,
      resourceType: original.resourceType,
      resourceId: original.resourceId,
      action: original.action,
      scope: original.scope,
      proposal: { titleSeo: 'Revised title' },
      revisionOfApprovalId: original.approvalId,
      ...mismatch
    }));
    assert.equal(result.http, 409);
    assert.equal(result.json.error.code, 'REVISION_MISMATCH');
  }

  const revision = await agent.submit(proposal({
    siteId: original.siteId,
    resourceType: original.resourceType,
    resourceId: original.resourceId,
    action: original.action,
    scope: original.scope,
    proposal: { titleSeo: 'Revised title' },
    revisionOfApprovalId: original.approvalId
  }));
  assert.equal(revision.revisionOfApprovalId, original.approvalId);
});

test('static handler serves the UI only and stays in the repo', async () => {
  const origin = 'http://127.0.0.1:' + PORT;
  const ui = await fetch(origin + '/demo/');
  assert.equal(ui.status, 200);
  const client = await fetch(origin + '/src/client.js');
  assert.equal(client.status, 200);
  const pkg = await fetch(origin + '/package.json');
  assert.equal(pkg.status, 404);
  const escape = await fetch(origin + '/%2e%2e/%2e%2e/Windows/win.ini');
  assert.ok(escape.status === 404 || escape.status === 400);
});
