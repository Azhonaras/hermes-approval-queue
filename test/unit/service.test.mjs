import test from 'node:test';
import assert from 'node:assert/strict';
import { createApprovalService, createMemoryStore, createMemoryCms, SEO_PROFILE } from '../../src/server/index.mjs';

const REVIEWER = { id: 'manager.test' };
const code = (c) => (e) => e.code === c;

function setup({ cmsOverride } = {}) {
  let now = Date.parse('2026-01-01T00:00:00Z');
  const store = createMemoryStore();
  const cms = createMemoryCms({ resources: [{ resourceType: 'article', resourceId: 42, fields: { canonical: '' } }] });
  const service = createApprovalService({
    store, cms: cmsOverride ? { ...cms, ...cmsOverride } : cms, profile: SEO_PROFILE, clock: () => now
  });
  return { service, cms, store, advance: (ms) => { now += ms; } };
}
const proposal = (extra) => ({
  siteId: 1, resourceType: 'article', resourceId: 42, action: 'update:canonical',
  scope: 'seo:write', reason: 'r', proposal: { canonical: 'https://example.com/a' }, ...extra
});
const writeOf = (row) => ({
  approvalId: row.approvalId, resourceType: row.resourceType, resourceId: row.resourceId,
  action: row.action, scope: row.scope, proposal: row.proposal
});

test('happy path: submit, approve, execute changes the CMS exactly once', async () => {
  const { service, cms } = setup();
  const row = await service.submit(proposal());
  assert.equal(row.status, 'Pending');
  assert.deepEqual(await cms.read({ resourceType: 'article', resourceId: 42 }), { canonical: '' });

  const approved = await service.decide(row.approvalId, 'approve', { reviewer: REVIEWER });
  assert.equal(approved.decidedBy, 'manager.test');

  const done = await service.execute(writeOf(approved));
  assert.equal(done.status, 'Consumed');
  assert.deepEqual(await cms.read({ resourceType: 'article', resourceId: 42 }), { canonical: 'https://example.com/a' });
  await assert.rejects(() => service.execute(writeOf(approved)), code('APPROVAL_NOT_USABLE'));
});

test('nothing is written while Pending, Rejected or ChangesRequested', async () => {
  const { service, cms } = setup();
  const a = await service.submit(proposal());
  await assert.rejects(() => service.execute(writeOf(a)), code('APPROVAL_PENDING'));
  await service.decide(a.approvalId, 'reject', { reviewer: REVIEWER, reason: 'no' });
  await assert.rejects(() => service.execute(writeOf(a)), code('APPROVAL_NOT_USABLE'));
  const b = await service.submit(proposal());
  await service.decide(b.approvalId, 'request-changes', { reviewer: REVIEWER, reason: 'fix' });
  await assert.rejects(() => service.execute(writeOf(b)), code('APPROVAL_NOT_USABLE'));
  assert.deepEqual(await cms.read({ resourceType: 'article', resourceId: 42 }), { canonical: '' });
});

test('reject and request-changes need a reason; approve does not', async () => {
  const { service } = setup();
  const a = await service.submit(proposal());
  await assert.rejects(() => service.decide(a.approvalId, 'reject', { reviewer: REVIEWER, reason: '  ' }), code('DECISION_REASON_REQUIRED'));
  await assert.rejects(() => service.decide(a.approvalId, 'request-changes', { reviewer: REVIEWER }), code('DECISION_REASON_REQUIRED'));
  await service.decide(a.approvalId, 'approve', { reviewer: REVIEWER });
});

test('deciding needs a reviewer identity and only works on Pending rows', async () => {
  const { service } = setup();
  const a = await service.submit(proposal());
  await assert.rejects(() => service.decide(a.approvalId, 'approve', {}), code('SCOPE_DENIED'));
  await service.decide(a.approvalId, 'approve', { reviewer: REVIEWER });
  await assert.rejects(() => service.decide(a.approvalId, 'reject', { reviewer: REVIEWER, reason: 'late' }), code('APPROVAL_NOT_PENDING'));
});

test('reviewer can edit the payload; the agent must then write the edited JSON', async () => {
  const { service, cms } = setup();
  const a = await service.submit(proposal());
  const edited = { canonical: 'https://example.com/fixed' };
  const approved = await service.decide(a.approvalId, 'approve', { reviewer: REVIEWER, proposal: edited });
  assert.equal(approved.editedProposal, true);
  assert.deepEqual(approved.originalProposal, { canonical: 'https://example.com/a' });
  assert.deepEqual(approved.proposal, edited);

  await assert.rejects(() => service.execute(writeOf(a)), code('APPROVAL_PAYLOAD_MISMATCH'));
  await service.execute(writeOf(approved));
  assert.deepEqual(await cms.read({ resourceType: 'article', resourceId: 42 }), edited);
});

test('an unchanged payload is not marked as edited; bad edits are refused', async () => {
  const { service } = setup();
  const a = await service.submit(proposal());
  const same = await service.decide(a.approvalId, 'approve', { reviewer: REVIEWER, proposal: { canonical: 'https://example.com/a' } });
  assert.equal(same.editedProposal, false);

  const b = await service.submit(proposal());
  await assert.rejects(() => service.decide(b.approvalId, 'approve', { reviewer: REVIEWER, proposal: [] }), code('BAD_REQUEST'));
  await assert.rejects(() => service.decide(b.approvalId, 'reject', { reviewer: REVIEWER, reason: 'x', proposal: { a: 1 } }), code('BAD_REQUEST'));
});

test('a CMS failure returns the approval to Approved so it can be retried', async () => {
  let fail = true;
  const { service, store, cms } = setup({
    cmsOverride: { apply: async (w) => { if (fail) throw new Error('db down'); return { ok: true, w }; } }
  });
  const a = await service.submit(proposal());
  const approved = await service.decide(a.approvalId, 'approve', { reviewer: REVIEWER });
  await assert.rejects(() => service.execute(writeOf(approved)), code('WRITE_FAILED'));
  assert.equal((await store.get(a.approvalId)).status, 'Approved');
  fail = false;
  assert.equal((await service.execute(writeOf(approved))).status, 'Consumed');
  void cms;
});

test('two concurrent writes of one approval: exactly one wins', async () => {
  const { service } = setup();
  const a = await service.submit(proposal());
  const approved = await service.decide(a.approvalId, 'approve', { reviewer: REVIEWER });
  const results = await Promise.allSettled([service.execute(writeOf(approved)), service.execute(writeOf(approved))]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(results.find((r) => r.status === 'rejected').reason.code, 'APPROVAL_NOT_USABLE');
});

test('two reviewers deciding the same row: exactly one wins', async () => {
  const { service } = setup();
  const a = await service.submit(proposal());
  const results = await Promise.allSettled([
    service.decide(a.approvalId, 'approve', { reviewer: REVIEWER }),
    service.decide(a.approvalId, 'reject', { reviewer: { id: 'other' }, reason: 'no' })
  ]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
});

test('rows expire on the clock, both Pending and Approved', async () => {
  const { service, advance } = setup();
  const a = await service.submit(proposal());
  const b = await service.submit(proposal({ resourceId: 43 }));
  const approvedB = await service.decide(b.approvalId, 'approve', { reviewer: REVIEWER });
  advance(25 * 3600 * 1000);
  assert.equal((await service.get(a.approvalId)).status, 'Expired');
  await assert.rejects(() => service.execute(writeOf(approvedB)), code('APPROVAL_EXPIRED'));
  await assert.rejects(() => service.decide(a.approvalId, 'approve', { reviewer: REVIEWER }), code('APPROVAL_NOT_PENDING'));
});

test('pending list excludes decided rows; history keeps Approved until consumed', async () => {
  const { service } = setup();
  const a = await service.submit(proposal());
  const b = await service.submit(proposal({ resourceId: 50 }));
  await service.decide(a.approvalId, 'approve', { reviewer: REVIEWER });
  assert.deepEqual((await service.list('pending')).map((r) => r.approvalId), [b.approvalId]);
  assert.deepEqual((await service.list('history')).map((r) => r.approvalId), [a.approvalId]);
  await assert.rejects(() => service.list('all'), code('BAD_REQUEST'));
});

test('revisions: only after ChangesRequested, parent untouched', async () => {
  const { service } = setup();
  const a = await service.submit(proposal());
  await assert.rejects(() => service.submit(proposal({ revisionOfApprovalId: a.approvalId })), code('REVISION_NOT_REQUESTED'));
  await assert.rejects(() => service.submit(proposal({ revisionOfApprovalId: 999 })), code('NOT_FOUND'));
  await service.decide(a.approvalId, 'request-changes', { reviewer: REVIEWER, reason: 'shorter' });
  const rev = await service.submit(proposal({ revisionOfApprovalId: a.approvalId, proposal: { canonical: 'https://example.com/b' } }));
  assert.notEqual(rev.approvalId, a.approvalId);
  assert.equal((await service.get(a.approvalId)).status, 'ChangesRequested');
});

test('read goes straight to the CMS and 404s for unknown resources', async () => {
  const { service } = setup();
  assert.deepEqual(await service.readResource({ resourceType: 'article', resourceId: 42 }), { canonical: '' });
  await assert.rejects(() => service.readResource({ resourceType: 'article', resourceId: 1 }), code('NOT_FOUND'));
});

test('delete flows through the same approval and removes the resource', async () => {
  const { service, cms } = setup();
  const a = await service.submit(proposal({ action: 'delete:taxonomy', proposal: {} }));
  const approved = await service.decide(a.approvalId, 'approve', { reviewer: REVIEWER });
  await service.execute(writeOf(approved));
  assert.equal(await cms.read({ resourceType: 'article', resourceId: 42 }), null);
});
