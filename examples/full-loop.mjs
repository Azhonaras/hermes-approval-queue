/**
 * Test harness: review session and write key are separate objects.
 * Production agents must not hold a review session.
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createAgentClient, createReviewClient } = require('../src/client.js');

const baseUrl = process.env.BASE_URL || 'http://127.0.0.1:8790/api/seo';
const agent = createAgentClient({ baseUrl, writeKey: 'demo-write' });
const review = createReviewClient({ baseUrl, session: 'demo-manager' });

const submitted = await agent.submit({
  siteId: 1,
  resourceType: 'article',
  resourceId: 42,
  action: 'update:canonical',
  scope: 'seo:write',
  reason: 'LOCALTEST harness.',
  proposal: { canonical: 'https://example.com/articles/sample-guide' }
});
console.log('agent submitted HRM-' + submitted.approvalId);

const denied = await fetch(baseUrl + '/proposals/' + submitted.approvalId + '/approve', {
  method: 'POST',
  headers: { 'X-Api-Key': 'demo-write', 'Content-Type': 'application/json' },
  body: '{}'
}).then((r) => r.json());
console.log('write key cannot approve:', denied.error && denied.error.code);

try {
  await agent.execute({
    approvalId: submitted.approvalId,
    resourceType: submitted.resourceType,
    resourceId: submitted.resourceId,
    action: submitted.action,
    scope: submitted.scope,
    proposal: submitted.proposal
  });
  console.error('write key must not execute a Pending proposal');
  process.exit(1);
} catch (err) {
  console.log('write blocked while Pending:', err.code);
}

const approved = await review.approve(submitted.approvalId);
console.log('review approved', approved.status);

const written = await agent.execute({
  approvalId: approved.approvalId,
  resourceType: approved.resourceType,
  resourceId: approved.resourceId,
  action: approved.action,
  scope: approved.scope,
  proposal: approved.proposal
});
console.log('agent executed', written.status || written);

try {
  await agent.execute({
    approvalId: approved.approvalId,
    resourceType: approved.resourceType,
    resourceId: approved.resourceId,
    action: approved.action,
    scope: approved.scope,
    proposal: approved.proposal
  });
  console.error('second write should fail');
  process.exit(1);
} catch (err) {
  console.log('second write blocked:', err.code);
}
