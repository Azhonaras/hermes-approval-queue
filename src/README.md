# `src/`

You can copy everything in this folder into your own project.

| Path | Role |
| --- | --- |
| [`client.js`](client.js) | Browser and Node client. Agent door (`X-Api-Key`) and review door: the demo's `X-Review-Session`, or your CMS's own sign-in headers (`createReviewClient({ baseUrl, headers })`, never an agent key) |
| [`receiver.js`](receiver.js) | Agent side of [decision notifications](../docs/spec.md#decision-notifications-optional): a small HTTP receiver that verifies the signature and the clock, so the agent is told when a person decides instead of polling |
| [`standing-agent.js`](standing-agent.js) | An agent that stays running. It remembers the requests it filed and redeems each approval when the notification arrives, so no chat session is needed. It also sweeps open requests at start-up and on a slow timer |
| [`server/`](server/) | Reference server modules for Node CMSs (below) |
| [`../docs/spec.md`](../docs/spec.md) | HTTP contract for every other stack |

## Server modules

```
server/
  core/                 pure rules, no I/O
    canonical.mjs       stable JSON for payload binding
    validate.mjs        submission and revision checks
    guard.mjs           bind + expiry checks on the write path
    status.mjs          lifecycle states
    profile.mjs         your actions, scopes and size limits
    errors.mjs          error codes -> HTTP status
    approval-service.mjs  submit / decide (+edit) / execute / list / read
  notify/webhook.mjs    decision notifications: the exact body, the signature, a sender that never fails a decision
  store/memory-store.mjs  replace with your database (4 methods, conditional update)
  cms/adapter.mjs         the contract your CMS implements: read() and apply()
  cms/memory-cms.mjs      demo content
  http/                 doors, routes, JSON envelope, mountable handler
  index.mjs             public exports
```

Each layer only knows the one below it. To connect a real CMS you write
a profile (your verbs), a store (your table) and a CMS adapter (`read` and
`apply` on top of your existing save code), plus the reviewer door that
reads your login session.

```js
import {
  createApprovalService, createProfile, createHttpHandler, apiKeyAgentDoor
} from './src/server/index.mjs';

const profile = createProfile({
  actions: ['update:post', 'delete:post'],
  scopes: ['content:write']
});
const service = createApprovalService({ store: myStore, cms: myCmsAdapter, profile });
app.use(createHttpHandler({
  service, profile, basePath: '/api/approvals',
  doors: {
    agent: apiKeyAgentDoor({ readKeys: [process.env.CMS_READ_KEY], writeKeys: [process.env.CMS_WRITE_KEY] }),
    reviewer: (req) => (req.session?.user?.isManager ? { id: req.session.user.name } : null)
  }
}));
```

Agent side:

```js
const CmsApproval = require('./src/client.js');
const agent = CmsApproval.createAgentClient({ baseUrl, writeKey: process.env.CMS_WRITE_KEY });
await agent.readResource('post', 12);   // reads need no approval
await agent.submit({ ... });            // writes wait for a human
```

To be told instead of polling, set `notifier: createWebhookNotifier({ url, secret })` on `createApprovalService` (the URL is the
operator's, never the agent's), and run a receiver on the agent's side:

```js
const { createReceiver } = require('./src/receiver.js');
const rx = await createReceiver({ port: 8795, secret: process.env.WEBHOOK_SECRET, onDecision: ({ approvalId }) => wake(approvalId) });
const row = await agent.waitForDecision(id, { intervalMs: 30000 });   // the slow poll is the safety net; it also returns at once for a row that is already decided
```

The write key cannot approve, and the agent must never be given a review session.
See [Connect your CMS](../docs/connect-your-cms.md).
