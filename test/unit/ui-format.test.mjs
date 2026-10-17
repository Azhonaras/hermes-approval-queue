import test from 'node:test';
import assert from 'node:assert/strict';
import { esc, firstLetterDir, textParts, riskOf, parseProposal, resource, unknownFields } from '../../demo/js/format.js';
import { card, queue, historyRows, approveItem, note, diffTable } from '../../demo/js/templates.js';

test('esc neutralizes markup and quotes', () => {
  assert.equal(esc('<img src=x onerror="a()">&\''), '&lt;img src=x onerror=&quot;a()&quot;&gt;&amp;&#39;');
  assert.equal(esc(null), '');
});

test('firstLetterDir reads the first strong letter', () => {
  assert.equal(firstLetterDir('  سلام hello'), 'rtl');
  assert.equal(firstLetterDir('Hello سلام'), 'ltr');
  assert.equal(firstLetterDir('123 !!'), 'auto');
});

test('textParts keeps Persian bare and wraps Latin in bdi', () => {
  const html = textParts('سلام canonical');
  assert.ok(html.includes('سلام'));
  assert.ok(html.includes('<bdi dir="ltr" class="mono-inline">canonical</bdi>'));
});

test('textParts keeps an English phrase in one bdi, so its words stay in order inside RTL text', () => {
  assert.equal(textParts('Title and description do not match.'), '<bdi dir="ltr" class="mono-inline">Title and description do not match.</bdi>');
  assert.equal(textParts('عنوان SEO title باید کوتاه شود'), 'عنوان <bdi dir="ltr" class="mono-inline">SEO title</bdi> باید کوتاه شود');
  assert.equal(textParts('  a  b '), '  <bdi dir="ltr" class="mono-inline">a  b</bdi> ');
});

test('textParts escapes a Persian word glued to markup (the agent must not run script in the review page)', () => {
  const evil = 'بررسی<img/src/onerror="alert(1)">';
  const html = textParts(evil);
  assert.ok(!html.includes('<img'), html);
  assert.ok(html.includes('&lt;img/src/onerror=&quot;alert(1)&quot;&gt;'), html);
  for (const t of [card({ approvalId: 1, resourceType: 'a', resourceId: 1, action: 'update:onpage', scope: 's', siteId: 1, reason: evil, proposal: {} }),
    approveItem({ approvalId: 1, resourceType: 'a', resourceId: 1, action: 'update:onpage', scope: 's', reason: evil, proposal: {} })]) {
    assert.ok(!/<img/i.test(t), t);
  }
});

test('risk is derived from the action, not from the agent', () => {
  for (const a of ['update:canonical', 'update:redirect', 'delete:taxonomy', 'merge:taxonomy', 'update:schema', 'update:content', 'delete:post']) assert.equal(riskOf(a), 'review');
  assert.equal(riskOf('update:onpage'), 'routine');
});

test('unknownFields lists proposal fields the CMS cannot write, only when the manifest says which it can', () => {
  const row = { action: 'update:onpage', proposal: { title: 'x', titel: 'y' } };
  assert.deepEqual(unknownFields(row, { 'update:onpage': ['title', 'slug'] }), ['titel']);
  assert.deepEqual(unknownFields(row, null), []);
  assert.deepEqual(unknownFields(row, { 'update:canonical': ['canonical'] }), []);
  const html = card({ ...row, approvalId: 3, resourceType: 'post', resourceId: 1, scope: 's', siteId: 1, reason: 'r' }, { 'update:onpage': ['title'] });
  assert.ok(html.includes('hq-warn') && html.includes('titel'));
});

test('diffTable shows before and after, escaped; a delete shows what goes', () => {
  const html = diffTable({ title: 'Old <b>', slug: 's' }, { action: 'update:onpage', proposal: { title: 'New', slug: 's' } });
  assert.ok(html.includes('Old &lt;b&gt;') && html.includes('New'));
  assert.ok(html.includes('class="is-same"'));
  const del = diffTable({ title: 'Old post' }, { action: 'delete:post', proposal: {} });
  assert.ok(del.includes('Old post') && del.includes('حذف می‌شود'));
  assert.ok(diffTable(null, { action: 'update:onpage', proposal: {} }).includes('hq-current__none'));
});

test('parseProposal accepts objects only', () => {
  assert.deepEqual(parseProposal('{"a":1}'), { value: { a: 1 } });
  for (const bad of ['[1]', '"x"', 'null', '{oops', '']) assert.ok(parseProposal(bad).error, bad);
});

test('templates escape agent-controlled text everywhere', () => {
  const evil = '<script>alert(1)</script>';
  const row = { approvalId: 1, resourceType: evil, resourceId: evil, action: evil, scope: evil, siteId: evil, reason: evil,
    status: 'Pending', proposal: { x: evil }, createdUtc: null, expiresUtc: null, revisionOfApprovalId: evil };
  for (const html of [card(row), queue([row]), approveItem(row), note(evil),
    historyRows([{ ...row, status: evil, decidedBy: evil, decisionReason: evil, editedProposal: true, originalProposal: { y: evil } }])]) {
    assert.ok(!html.includes('<script>'), html.slice(0, 120));
  }
});

test('empty queue shows the empty message; history marks edited payloads', () => {
  assert.ok(queue([]).includes('hq-empty'));
  const html = historyRows([{ approvalId: 5, resourceType: 'a', resourceId: 1, action: 'update:onpage', status: 'Approved',
    proposal: { t: 'new' }, originalProposal: { t: 'old' }, editedProposal: true, decidedBy: 'm', decidedUtc: '2026-01-01T00:00:00Z' }]);
  assert.ok(html.includes('ویرایش‌شده'));
  assert.ok(html.includes('&quot;old&quot;'));
  assert.equal(resource({ resourceType: 'page', resourceId: null }), 'page');
});

test('the approve dialog exposes an editable, labelled payload field', () => {
  const html = approveItem({ approvalId: 7, resourceType: 'a', resourceId: 1, action: 'update:onpage', scope: 's', reason: 'r', proposal: { t: 1 } });
  assert.ok(html.includes('<textarea'));
  assert.ok(html.includes('hq-edit__error'));
});
