/**
 * Agent door + a receiver: submit, then wait for the CMS to say that a person has decided, instead of asking every
 * two seconds. A slow poll stays on as the safety net, because a notification is sent at most once (docs/spec.md,
 * "Decision notifications").
 *
 *   WEBHOOK_URL=http://127.0.0.1:8795/hook WEBHOOK_SECRET=demo-secret npm start     # the demo CMS, terminal 1
 *   WEBHOOK_SECRET=demo-secret npm run agent:webhook                                # this agent, terminal 2
 *
 * Approve it in http://127.0.0.1:8790/demo/ and the agent wakes up at once.
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createAgentClient } = require('../src/client.js');
const { createReceiver } = require('../src/receiver.js');

const baseUrl = process.env.BASE_URL || 'http://127.0.0.1:8790/api/seo';
const WAIT_MINUTES = Number(process.env.WAIT_MINUTES || 10);
const agent = createAgentClient({ baseUrl, writeKey: 'demo-write' });

// Listen first: the person could decide the moment the request exists.
const nudged = new Set();
let wake = () => {};
const receiver = await createReceiver({
  port: Number(process.env.RECEIVER_PORT || 8795),
  secret: process.env.WEBHOOK_SECRET || '',
  onDecision: ({ approvalId, status }, { signed }) => {
    console.log('notified: HRM-' + approvalId + ' is ' + status + (signed ? ' (signature checked)' : ' (unsigned: treat as a hint)'));
    nudged.add(approvalId);
    wake();
  }
});
console.log('listening for decisions on ' + receiver.url);

const submitted = await agent.submit({
  siteId: 1,
  resourceType: 'page',
  resourceId: 88,
  action: 'update:onpage',
  scope: 'seo:write',
  reason: 'LOCALTEST sample from the notification example.',
  proposal: { titleSeo: 'Sample guide | Example' }
});
console.log('submitted HRM-' + submitted.approvalId + '. Approve it in http://127.0.0.1:8790/demo/');

// Either the nudge or the slow poll ends the wait. The nudge carries nothing but the id: read the row with our own key.
const told = new Promise((resolve) => { wake = () => { if (nudged.has(submitted.approvalId)) resolve(); }; });
const polled = agent.waitForDecision(submitted.approvalId, { intervalMs: 30000, timeoutMs: WAIT_MINUTES * 60000 });
try {
  await Promise.race([told, polled]);
} catch (err) {
  if (err.code !== 'WAIT_TIMEOUT') throw err;
}
const row = await agent.get(submitted.approvalId);

if (row.status === 'Approved') {
  const written = await agent.execute({
    approvalId: row.approvalId,
    resourceType: row.resourceType,
    resourceId: row.resourceId,
    action: row.action,
    scope: row.scope,
    proposal: row.proposal
  });
  console.log('executed', written);
} else {
  console.log('HRM-' + row.approvalId + ' is ' + row.status + (row.decisionReason ? ': ' + row.decisionReason : ''));
}
await receiver.close();
process.exit(row.status === 'Pending' ? 2 : 0); // the poll may still be sleeping; do not wait for it
