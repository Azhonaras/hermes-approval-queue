/**
 * A standing agent you start once and leave running: it files requests (optional), then redeems each one by itself the
 * moment a person approves it, and records rejections and change requests. No chat session is involved, so nothing can
 * go to sleep between the decision and the write.
 *
 *   BASE_URL=http://127.0.0.1:8881/wp-json/hermes-approval/v1 WRITE_KEY=... WEBHOOK_SECRET=... \
 *   STATE_FILE=standing-agent.json LOG_FILE=standing-agent.log \
 *   node examples/standing-agent.mjs                       # add WATCH=14,15 for requests filed some other way
 *                                                          # or SUBMIT_FILE=requests.json (a JSON array of proposals)
 *
 * Point the CMS at it: HERMES_APPROVAL_WEBHOOK_URL=http://127.0.0.1:8796/hook (WordPress), WEBHOOK_URL (demo CMS).
 * Demo CMS: BASE_URL defaults to it and WRITE_KEY to demo-write.
 */
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createAgentClient } = require('../src/client.js');
const { createStandingAgent } = require('../src/standing-agent.js');

const env = process.env;
const logFile = env.LOG_FILE || '';
const stamp = (level, args) => '[' + new Date().toISOString() + '] ' + (level ? level + ' ' : '') + args.join(' ');
const out = (level, args) => {
  const line = stamp(level, args);
  (level ? console.error : console.log)(line);
  if (logFile) try { fs.appendFileSync(logFile, line + '\n'); } catch { /* keep running */ }
};
const logger = { log: (...a) => out('', a), warn: (...a) => out('WARN', a) };

const agent = createAgentClient({
  baseUrl: env.BASE_URL || 'http://127.0.0.1:8790/api/seo',
  writeKey: env.WRITE_KEY || 'demo-write'
});
const standing = createStandingAgent({
  agent,
  receiver: { port: Number(env.RECEIVER_PORT || 8796), host: env.RECEIVER_HOST || '127.0.0.1', secret: env.WEBHOOK_SECRET || '' },
  stateFile: env.STATE_FILE || '',
  pollMs: Number(env.POLL_SECONDS || 30) * 1000,
  logger,
  onOutcome: (o) => logger.log('outcome HRM-' + o.approvalId + ': ' + o.status + (o.error ? ' (' + o.error.code + ')' : ''))
});

const { url } = await standing.start();
logger.log('standing agent listening on ' + url + (env.WEBHOOK_SECRET ? ' (signed)' : ' (unsigned: nudges are hints only)'));
for (const id of (env.WATCH || '').split(',').map((s) => s.trim()).filter(Boolean)) standing.track(Number(id));
if (env.SUBMIT_FILE) {
  for (const proposal of JSON.parse(fs.readFileSync(env.SUBMIT_FILE, 'utf8'))) {
    const row = await standing.submit(proposal);
    logger.log('filed HRM-' + row.approvalId);
  }
}
logger.log('waiting on: ' + (standing.open().map((i) => 'HRM-' + i).join(', ') || 'nothing yet'));

for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { await standing.stop(); process.exit(0); });
