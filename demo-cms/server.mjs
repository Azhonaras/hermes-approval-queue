/**
 * Demo CMS: wires the reusable modules from src/server to in-memory data.
 * Dummy keys only, bound to 127.0.0.1. Serves the review UI from /demo and the API from /api/seo.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createApprovalService, createMemoryStore, createMemoryCms, createHttpHandler,
  apiKeyAgentDoor, headerReviewerDoor, createWebhookNotifier, SEO_PROFILE
} from '../src/server/index.mjs';
import { createStaticHandler } from './static.mjs';
import { error } from '../src/server/http/respond.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8790);
const BASE_PATH = '/api/seo';

/**
 * `webhook` ({ url, secret?, logger? }) turns on decision notifications: the receiver is told when a person decides,
 * so an agent does not have to poll (docs/spec.md). Off unless asked for.
 * `mutate` is a test hook: it receives the wired parts and may return broken copies,
 * which is how the conformance suite proves it catches a faulty implementation.
 */
export function createDemoApp({ seedPath = path.join(__dirname, 'seed.json'), mutate = {}, webhook = null } = {}) {
  const seed = JSON.parse(fs.readFileSync(seedPath, 'utf8'));
  const store = (mutate.store || ((x) => x))(createMemoryStore(seed));
  const cms = createMemoryCms({
    resources: [
      { resourceType: 'article', resourceId: 42, fields: { title: 'Sample guide', canonical: '' } },
      { resourceType: 'page', resourceId: 88, fields: { titleSeo: 'Old title' } }
    ]
  });
  const notifier = (mutate.notifier || ((x) => x))(webhook && webhook.url ? createWebhookNotifier(webhook) : null, webhook);
  const service = (mutate.service || ((x) => x))(createApprovalService({ store, cms, profile: SEO_PROFILE, notifier }), store, webhook);
  const doors = (mutate.doors || ((x) => x))({
    agent: apiKeyAgentDoor({ readKeys: ['demo-read'], writeKeys: ['demo-write'] }),
    reviewer: headerReviewerDoor({ sessions: { 'demo-manager': 'manager.demo' } })
  });
  const api = (mutate.http || ((x) => x))(createHttpHandler({
    service, profile: SEO_PROFILE, doors, basePath: BASE_PATH,
    cors: { origin: '*' } // demo only: the local UI calls the API cross-origin. Do not copy to a public host.
  }));
  const serveStatic = createStaticHandler(path.resolve(__dirname, '..'));

  const server = http.createServer(async (req, res) => {
    if (await api(req, res)) return;
    if (!serveStatic(new URL(req.url, 'http://127.0.0.1').pathname, res)) {
      error(res, 404, 'NOT_FOUND', 'Not found.');
    }
  });
  return { server, service, store, cms };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // WEBHOOK_URL=http://127.0.0.1:8795/hook WEBHOOK_SECRET=demo-secret npm start   (see examples/agent-webhook.mjs)
  const webhook = process.env.WEBHOOK_URL ? { url: process.env.WEBHOOK_URL, secret: process.env.WEBHOOK_SECRET || '' } : null;
  const { server } = createDemoApp({ webhook });
  server.listen(PORT, '127.0.0.1', () => {
    console.log('Review UI   http://127.0.0.1:' + PORT + '/demo/');
    console.log('API         http://127.0.0.1:' + PORT + BASE_PATH);
    console.log('Agent keys  demo-read  /  demo-write   (cannot approve)');
    console.log('Review      X-Review-Session: demo-manager');
    if (webhook) console.log('Webhook     ' + webhook.url + (webhook.secret ? ' (signed)' : ' (unsigned)'));
  });
}
