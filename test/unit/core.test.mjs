import test from 'node:test';
import assert from 'node:assert/strict';
import { canonical, sameJson } from '../../src/server/core/canonical.mjs';
import { createProfile, SEO_PROFILE } from '../../src/server/core/profile.mjs';
import { validateSubmission, assertRevisionMatches } from '../../src/server/core/validate.mjs';
import { assertBound } from '../../src/server/core/guard.mjs';

const NOW = Date.parse('2026-01-01T00:00:00Z');
const valid = () => ({
  siteId: 1, resourceType: 'article', resourceId: 42, action: 'update:canonical',
  scope: 'seo:write', reason: 'x', proposal: { canonical: 'https://example.com/a' }
});
const approvedRow = (extra = {}) => ({
  approvalId: 1, siteId: 1, resourceType: 'article', resourceId: 42, action: 'update:canonical',
  scope: 'seo:write', status: 'Approved', proposal: { canonical: 'https://example.com/a' },
  expiresUtc: '2026-01-02T00:00:00Z', ...extra
});
const code = (c) => (e) => e.code === c;

test('canonical ignores key order at every depth and keeps array order', () => {
  assert.equal(canonical({ b: 1, a: { d: 1, c: 2 } }), canonical({ a: { c: 2, d: 1 }, b: 1 }));
  assert.notEqual(canonical([1, 2]), canonical([2, 1]));
  assert.ok(sameJson({ a: undefined, b: 1 }, { b: 1 }));
});

test('canonical keeps non-ASCII text intact', () => {
  assert.equal(canonical({ t: 'عنوان' }), '{"t":"عنوان"}');
});

test('profile rejects bare verbs like "update"', () => {
  assert.throws(() => createProfile({ actions: ['update'], scopes: ['s'] }), /verb:target/);
  assert.throws(() => createProfile({ actions: [], scopes: ['s'] }), /non-empty/);
});

test('submission accepts a valid body and normalizes it', () => {
  const out = validateSubmission({ ...valid(), resourceType: ' article ', siteId: undefined }, SEO_PROFILE);
  assert.equal(out.resourceType, 'article');
  assert.equal(out.siteId, 1);
});

test('submission rejects unknown action, scope, empty and oversized payloads', () => {
  for (const bad of [
    { action: 'update' }, { action: 'drop:table' }, { scope: 'root' },
    { proposal: {} }, { proposal: [] }, { proposal: 'x' }, { resourceId: '' },
    { reason: 'x'.repeat(1025) },
    { proposal: { big: 'x'.repeat(17000) } },
    { proposal: Object.fromEntries(Array.from({ length: 41 }, (_, i) => ['k' + i, i])) }
  ]) {
    assert.throws(() => validateSubmission({ ...valid(), ...bad }, SEO_PROFILE), code('BAD_REQUEST'), JSON.stringify(bad).slice(0, 40));
  }
});

test('delete actions may send an empty proposal', () => {
  const out = validateSubmission({ ...valid(), action: 'delete:taxonomy', proposal: {} }, SEO_PROFILE);
  assert.deepEqual(out.proposal, {});
});

test('revision must keep site, resource, action and scope', () => {
  const parent = { siteId: 1, resourceType: 'article', resourceId: 42, action: 'update:canonical', scope: 'seo:write' };
  assertRevisionMatches(parent, valid());
  for (const change of [{ siteId: 2 }, { resourceType: 'page' }, { resourceId: 1 }, { action: 'update:redirect' }, { scope: 'content:update' }]) {
    assert.throws(() => assertRevisionMatches(parent, { ...valid(), ...change }), code('REVISION_MISMATCH'));
  }
});

test('guard passes only an Approved, unexpired, exactly matching write', () => {
  assertBound(approvedRow(), valid(), NOW);
});

test('guard names each way a write can fail', () => {
  const cases = [
    [{ status: 'Pending' }, {}, 'APPROVAL_PENDING'],
    [{ status: 'Expired' }, {}, 'APPROVAL_EXPIRED'],
    [{ status: 'Consumed' }, {}, 'APPROVAL_NOT_USABLE'],
    [{ status: 'Rejected' }, {}, 'APPROVAL_NOT_USABLE'],
    [{ expiresUtc: '2025-01-01T00:00:00Z' }, {}, 'APPROVAL_EXPIRED'],
    [{}, { action: 'update:redirect' }, 'APPROVAL_MISMATCH'],
    [{}, { resourceId: 43 }, 'APPROVAL_MISMATCH'],
    [{}, { scope: 'content:update' }, 'APPROVAL_MISMATCH'],
    [{}, { siteId: 9 }, 'APPROVAL_MISMATCH'],
    [{}, { proposal: { canonical: 'https://evil.example' } }, 'APPROVAL_PAYLOAD_MISMATCH'],
    [{}, { proposal: { canonical: 'https://example.com/a', extra: 1 } }, 'APPROVAL_PAYLOAD_MISMATCH']
  ];
  for (const [rowExtra, writeExtra, expected] of cases) {
    assert.throws(() => assertBound(approvedRow(rowExtra), { ...valid(), ...writeExtra }, NOW), code(expected), expected);
  }
});

test('guard treats key order as the same payload', () => {
  const row = approvedRow({ proposal: { a: 1, b: 2 } });
  assertBound(row, { ...valid(), proposal: { b: 2, a: 1 } }, NOW);
});
