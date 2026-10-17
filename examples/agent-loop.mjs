/**
 * Agent door only: submit, wait for a person, execute.
 * Approve happens in the review UI (or run full-loop.mjs for a harness).
 * To be told instead of asking, see agent-webhook.mjs.
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createAgentClient } = require('../src/client.js');

const baseUrl = process.env.BASE_URL || 'http://127.0.0.1:8790/api/seo';
const agent = createAgentClient({ baseUrl, writeKey: 'demo-write' });

const proposal = {
  siteId: 1,
  resourceType: 'page',
  resourceId: 88,
  action: 'update:onpage',
  scope: 'seo:write',
  reason: 'LOCALTEST sample from the public agent client.',
  proposal: { titleSeo: 'Sample guide | Example' }
};

// A human decides, so wait minutes, not seconds. The approval itself stays valid for 24 hours: run the loop again with
// APPROVAL_ID=<id> to pick up a decision made after this script stopped waiting.
const WAIT_MINUTES = Number(process.env.WAIT_MINUTES || 10);

const submitted = process.env.APPROVAL_ID ? await agent.get(Number(process.env.APPROVAL_ID)) : await agent.submit(proposal);
console.log((process.env.APPROVAL_ID ? 'resumed' : 'submitted') + ' HRM-' + submitted.approvalId, submitted.status);
console.log('Approve it in http://127.0.0.1:8790/demo/ (waiting up to ' + WAIT_MINUTES + ' minutes), then this script will execute.');

let row;
try {
  // Resolves at once for a request that was already decided before this script looked.
  row = await agent.waitForDecision(submitted.approvalId, { timeoutMs: WAIT_MINUTES * 60000 });
} catch (err) {
  if (err.code !== 'WAIT_TIMEOUT') throw err;
  console.log('still pending. Approve HRM-' + submitted.approvalId + ' in the UI, then set APPROVAL_ID=' + submitted.approvalId + ' and run npm run agent again.');
  process.exit(2);
}

if (row.status !== 'Approved') {
  console.log('stopped:', row.status, row.decisionReason || '');
  process.exit(row.status === 'Rejected' || row.status === 'ChangesRequested' ? 0 : 1);
}

const written = await agent.execute({
  approvalId: row.approvalId,
  resourceType: row.resourceType,
  resourceId: row.resourceId,
  action: row.action,
  scope: row.scope,
  proposal: row.proposal
});
console.log('executed', written);
