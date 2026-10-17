/**
 * One command: run the whole conformance suite against a WordPress site that has the plugin active, typically a local
 * WordPress Playground (SQLite) started with ../playground/blueprint.json.
 *
 *   node playground-check.mjs http://127.0.0.1:8881 [--user admin] [--password password]
 *                             [--read-key demo-read] [--write-key demo-write] [--only edge] [--keep]
 *
 * It signs in the way a browser does (login cookie + REST nonce), creates one throwaway post to test against, runs
 * conformance/run.mjs, and deletes the post again (--keep leaves it). Test sites only: the suite approves and writes
 * real rows, and it needs a reviewer account that may edit posts.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { login } from './login.mjs';
import { isPlaygroundLimit } from './playground-limits.mjs';

const args = process.argv.slice(2);
const site = (args.find((a) => !a.startsWith('--') && /^https?:/.test(a)) || '').replace(/\/$/, '');
const option = (name, fallback) => { const i = args.indexOf('--' + name); return i >= 0 && args[i + 1] ? args[i + 1] : fallback; };
if (!site) {
  console.error('usage: node playground-check.mjs <siteUrl> [--user admin] [--password password] [--read-key K] [--write-key K] [--only <group>] [--keep]');
  process.exit(2);
}
const readKey = option('read-key', 'demo-read');
const writeKey = option('write-key', 'demo-write');
const api = site + '/wp-json/hermes-approval/v1';

const session = await login(site, option('user', 'admin'), option('password', 'password'));
// Connection: close, because the suite runs for minutes and Playground drops idle sockets (a reused one fails with EPIPE).
const wp = (method, route, body) => fetch(site + '/wp-json/wp/v2' + route, {
  method,
  headers: { 'Content-Type': 'application/json', Connection: 'close', Cookie: session.cookie, 'X-WP-Nonce': session.nonce },
  body: body === undefined ? undefined : JSON.stringify(body)
});

const created = await wp('POST', '/posts', { title: 'Hermes conformance fixture', content: 'Safe to delete.', status: 'publish' });
if (created.status !== 201) {
  console.error(`Could not create the test post (HTTP ${created.status}): ${(await created.text()).slice(0, 200)}`);
  process.exit(1);
}
const postId = (await created.json()).id;

const seeded = await fetch(api + '/proposals/1036', { headers: { 'X-Api-Key': readKey } }).then((r) => r.json()).catch(() => null);
const hasExpiredFixture = Boolean(seeded && seeded.success && String(seeded.data.expiresUtc).startsWith('2020-'));

const profile = {
  baseUrl: api,
  writeHeader: 'X-Api-Key: ' + writeKey,
  readHeader: 'X-Api-Key: ' + readKey,
  reviewHeaders: ['Cookie: ' + session.cookie, 'X-WP-Nonce: ' + session.nonce],
  resourceType: 'post', resourceId: postId, action: 'update:canonical', scope: 'seo:write',
  payload: { canonical: 'https://example.com/c-{{uid}}' },
  otherAction: 'update:redirect', otherScope: 'content:update', deleteAction: 'delete:taxonomy',
  verifyUrl: `${api}/resources/post/${postId}`, verifyField: 'canonical', verifyHeaders: ['X-Api-Key: ' + readKey],
  failingPayload: { canonical: 'https://example.com/partial-must-not-survive', redirect: 'not a url' },
  timeoutMs: 60000
};
if (hasExpiredFixture) {
  profile.expiredFixture = { approvalId: 1036, resourceType: 'page', resourceId: 77, action: 'update:onpage', scope: 'seo:write', proposal: { titleSeo: 'Expired sample' } };
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-pg-'));
const file = path.join(dir, 'profile.json');
const report = path.join(dir, 'report.json');
fs.writeFileSync(file, JSON.stringify(profile, null, 2), { mode: 0o600 });
const runner = fileURLToPath(new URL('../../../../conformance/run.mjs', import.meta.url));
console.log(`Testing ${api} with post ${postId}${hasExpiredFixture ? '' : ' (no expired fixture seeded: that one check will be skipped)'}\n`);
const only = option('only', '');
const run = spawnSync(process.execPath, [runner, '--config', file, '--json', report, '--yes', ...(only ? ['--only', only] : [])], { stdio: 'inherit' });

let failed = [];
try { failed = JSON.parse(fs.readFileSync(report, 'utf8')).results.filter((r) => r.outcome !== 'pass' && r.outcome !== 'skip' && r.level === 'must'); } catch { /* the runner died before writing a report */ }
fs.rmSync(dir, { recursive: true, force: true }); // the profile holds a live session

if (!args.includes('--keep')) {
  const deleted = await wp('DELETE', `/posts/${postId}?force=true`).then((r) => r.ok, () => false);
  if (!deleted) console.warn(`\nCould not delete the test post (id ${postId}); remove it by hand.`);
}

const onlyLimits = run.status === 1 && failed.length > 0 && failed.every(isPlaygroundLimit); // see playground-limits.mjs
if (onlyLimits) {
  console.log(`\nOnly ${failed.length} failure(s), all "500 on a malformed %-escape": ${failed.map((r) => r.id).join(', ')}.`);
  console.log('That is the Playground dev server answering before PHP runs, not this plugin. Counting the rest as a pass.');
  process.exit(0);
}
process.exit(run.status ?? 1);
