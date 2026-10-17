/**
 * WordPress-only scenarios the generic conformance suite cannot express: real roles, the browser session
 * (cookie + REST nonce), real posts and terms, Persian text and backslashes in real fields, the trash, and what the
 * live page shows a visitor after an approval.
 *
 *   node real-scenarios.mjs <baseUrl> <creds.json>
 *
 * creds.json comes from a test setup and holds Application Password headers for "manager" (editor), "writer"
 * (author) and "limited" (may approve, may not edit published posts), plus "cookie" and "nonce" for the
 * manager's browser session, "post" (a published post id) and "term" (a category id). Test sites only.
 */
import fs from 'node:fs';

const [base, credsPath] = process.argv.slice(2);
if (!base || !credsPath) { console.error('usage: node real-scenarios.mjs <baseUrl> <creds.json>'); process.exit(2); }
const creds = JSON.parse(fs.readFileSync(credsPath, 'utf8'));
const WRITE = { 'X-Api-Key': 'demo-write' };
const READ = { 'X-Api-Key': 'demo-read' };
const basic = (who) => ({ Authorization: 'Basic ' + creds[who] });
const uid = () => Math.random().toString(36).slice(2, 10);

async function call(method, path, headers = {}, body) {
  const res = await fetch(base + path, {
    method, headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { http: res.status, json, text, data: json && json.success ? json.data : null, code: json && json.error ? json.error.code : null };
}
const submit = (body) => call('POST', '/proposals', WRITE, { siteId: 1, scope: 'seo:write', reason: 'scenario', ...body });
const decide = (id, verb, headers, body = { reason: 'scenario' }) => call('POST', `/proposals/${id}/${verb}`, headers, body);
const write = (row) => call('POST', '/writes', WRITE, {
  approvalId: row.approvalId, resourceType: row.resourceType, resourceId: row.resourceId, action: row.action, scope: row.scope, proposal: row.proposal
});
const read = (type, id) => call('GET', `/resources/${type}/${id}`, READ);

const results = [];
async function scenario(name, fn) {
  try { await fn(); results.push([true, name]); } catch (e) { results.push([false, name, e.message]); }
}
function check(cond, msg) { if (!cond) throw new Error(msg); }

await scenario('An author (no edit_others_posts) cannot approve', async () => {
  const row = (await submit({ resourceType: 'post', resourceId: creds.post, action: 'update:canonical', proposal: { canonical: 'https://example.com/a-' + uid() } })).data;
  const r = await decide(row.approvalId, 'approve', basic('writer'), { reason: '' });
  check(r.http === 403 && r.code === 'SCOPE_DENIED', `expected 403 SCOPE_DENIED, got ${r.http} ${r.code}`);
});

await scenario('A logged-in cookie WITHOUT the REST nonce is not a reviewer (CSRF protection)', async () => {
  const row = (await submit({ resourceType: 'post', resourceId: creds.post, action: 'update:canonical', proposal: { canonical: 'https://example.com/b-' + uid() } })).data;
  const r = await decide(row.approvalId, 'approve', { Cookie: creds.cookie }, { reason: '' });
  check(r.http === 403, `expected 403, got ${r.http} ${r.text.slice(0, 120)}`);
});

await scenario('The same cookie WITH the nonce approves, recorded as that user', async () => {
  const row = (await submit({ resourceType: 'post', resourceId: creds.post, action: 'update:canonical', proposal: { canonical: 'https://example.com/c-' + uid() } })).data;
  const r = await decide(row.approvalId, 'approve', { Cookie: creds.cookie, 'X-WP-Nonce': creds.nonce }, { reason: '' });
  check(r.http === 200 && r.data.decidedBy === 'manager', `expected 200 by manager, got ${r.http} ${r.text.slice(0, 160)}`);
});

await scenario('The write key plus a valid browser session still cannot approve', async () => {
  const row = (await submit({ resourceType: 'post', resourceId: creds.post, action: 'update:canonical', proposal: { canonical: 'https://example.com/d-' + uid() } })).data;
  const r = await decide(row.approvalId, 'approve', { ...WRITE, Cookie: creds.cookie, 'X-WP-Nonce': creds.nonce }, { reason: '' });
  check(r.http === 403, `expected 403, got ${r.http}`);
});

await scenario('An approval never grants more than the approver has (limited reviewer, published post)', async () => {
  const before = (await read('post', creds.post)).data;
  const row = (await submit({ resourceType: 'post', resourceId: creds.post, action: 'update:canonical', proposal: { canonical: 'https://example.com/e-' + uid() } })).data;
  const a = await decide(row.approvalId, 'approve', basic('limited'), { reason: '' });
  check(a.http === 200, `the limited reviewer may approve (has edit_others_posts), got ${a.http}`);
  const w = await write(a.data);
  check(w.http === 502 && w.code === 'WRITE_FAILED', `expected 502 WRITE_FAILED, got ${w.http} ${w.text.slice(0, 160)}`);
  check(JSON.stringify((await read('post', creds.post)).data) === JSON.stringify(before), 'post changed although the approver may not edit it');
  const polled = (await call('GET', '/proposals/' + row.approvalId, READ)).data;
  check(polled.status === 'Approved', 'row should be Approved again, is ' + polled.status);
});

await scenario('Persian and emoji text lands in a real post title unchanged', async () => {
  const title = 'راهنمای مراقبت از پوست 🙂 ' + uid();
  const row = (await submit({ resourceType: 'post', resourceId: creds.post, action: 'update:onpage', proposal: { title } })).data;
  const a = (await decide(row.approvalId, 'approve', basic('manager'), { reason: '' })).data;
  const w = await write(a);
  check(w.http === 200, `write failed: ${w.http} ${w.text.slice(0, 160)}`);
  const now = (await read('post', creds.post)).data;
  check(now.title === title, `title is ${JSON.stringify(now.title)}`);
});

await scenario('A failing field after a saved title rolls the title back too (real wp_update_post + meta)', async () => {
  const before = (await read('post', creds.post)).data;
  const row = (await submit({ resourceType: 'post', resourceId: creds.post, action: 'update:onpage', proposal: { title: 'Must not survive ' + uid(), titleSeo: 'x'.repeat(250) } })).data;
  const a = (await decide(row.approvalId, 'approve', basic('manager'), { reason: '' })).data;
  const w = await write(a);
  check(w.http === 502, `expected 502, got ${w.http}`);
  check(JSON.stringify((await read('post', creds.post)).data) === JSON.stringify(before), 'the title change survived the failed write');
});

await scenario('Rename, then delete a real category through the queue', async () => {
  const name = 'Hydration ' + uid();
  // A category the agent may change: created directly for the test, then renamed and deleted through approvals.
  const created = await call('POST', '/../../wp/v2/categories', basic('manager'), { name });
  check(created.http === 201, `could not create a category: ${created.http} ${created.text.slice(0, 120)}`);
  const id = created.json.id;
  const ren = (await submit({ resourceType: 'term', resourceId: id, action: 'update:taxonomy', scope: 'content:update', proposal: { name: name + ' (renamed)' } })).data;
  const renW = await write((await decide(ren.approvalId, 'approve', basic('manager'), { reason: '' })).data);
  check(renW.http === 200 && (await read('term', id)).data.name === name + ' (renamed)', `rename failed: ${renW.http} ${renW.text.slice(0, 120)}`);
  const del = (await submit({ resourceType: 'term', resourceId: id, action: 'delete:taxonomy', scope: 'content:update', proposal: {} })).data;
  check((await read('term', id)).http === 200, 'term vanished before approval');
  const delW = await write((await decide(del.approvalId, 'approve', basic('manager'), { reason: '' })).data);
  check(delW.http === 200, `delete failed: ${delW.http} ${delW.text.slice(0, 120)}`);
  check((await read('term', id)).http === 404, 'term still exists after the approved delete');
});

await scenario('A field outside the action\'s whitelist is refused by the CMS, not silently saved', async () => {
  const row = (await submit({ resourceType: 'post', resourceId: creds.post, action: 'update:canonical', proposal: { canonical: 'https://example.com/f-' + uid(), post_status: 'draft' } })).data;
  const w = await write((await decide(row.approvalId, 'approve', basic('manager'), { reason: '' })).data);
  check(w.http === 502, `expected 502, got ${w.http}`);
  check((await read('post', creds.post)).data.status === 'publish', 'post status changed');
});

const approveAndWrite = async (row) => write((await decide(row.approvalId, 'approve', basic('manager'), { reason: '' })).data);
const newPost = async (fields) => {
  const created = await call('POST', '/../../wp/v2/posts', basic('manager'), { status: 'publish', ...fields });
  check(created.http === 201, `could not create a post: ${created.http} ${created.text.slice(0, 120)}`);
  return created.json;
};

await scenario('Backslashes the reviewer approved are saved as written (title, SEO title, category description)', async () => {
  // wp_update_post(), wp_update_term() and update_post_meta() strip one level of backslashes from what they are given.
  const title = 'Path C:\\Users\\guide ' + uid();
  const titleSeo = 'Regex \\d+ and \\n ' + uid();
  const w = await approveAndWrite((await submit({ resourceType: 'post', resourceId: creds.post, action: 'update:onpage', proposal: { title, titleSeo } })).data);
  check(w.http === 200, `write failed: ${w.http} ${w.text.slice(0, 160)}`);
  const now = (await read('post', creds.post)).data;
  check(now.title === title && now.titleSeo === titleSeo, `saved ${JSON.stringify([now.title, now.titleSeo])}`);
  const cat = await call('POST', '/../../wp/v2/categories', basic('manager'), { name: 'Slashes ' + uid() });
  check(cat.http === 201, `could not create a category: ${cat.http}`);
  const description = 'Folder C:\\temp\\site ' + uid();
  const tw = await approveAndWrite((await submit({ resourceType: 'term', resourceId: cat.json.id, action: 'update:taxonomy', scope: 'content:update', proposal: { description } })).data);
  const term = (await read('term', cat.json.id)).data;
  check(tw.http === 200 && term.description === description, `saved ${JSON.stringify(term && term.description)}`);
});

await scenario('The post body changes through the queue (update:content)', async () => {
  const post = await newPost({ title: 'Body ' + uid(), content: 'Old body' });
  const content = '<!-- wp:paragraph --><p>New body ' + uid() + '</p><!-- /wp:paragraph -->';
  const w = await approveAndWrite((await submit({ resourceType: 'post', resourceId: post.id, action: 'update:content', scope: 'content:update', proposal: { content } })).data);
  check(w.http === 200, `write failed: ${w.http} ${w.text.slice(0, 160)}`);
  check((await read('post', post.id)).data.content === content, 'the body was not saved as approved');
});

await scenario('An approved delete moves the post to the trash, where an editor can restore it', async () => {
  const post = await newPost({ title: 'Old news ' + uid() });
  const row = (await submit({ resourceType: 'post', resourceId: post.id, action: 'delete:post', scope: 'content:update', proposal: {} })).data;
  check((await read('post', post.id)).http === 200, 'post vanished before approval');
  const w = await approveAndWrite(row);
  check(w.http === 200, `delete failed: ${w.http} ${w.text.slice(0, 160)}`);
  check((await read('post', post.id)).http === 404, 'the agent can still read the deleted post');
  const raw = await call('GET', `/../../wp/v2/posts/${post.id}?context=edit`, basic('manager'));
  check(raw.http === 200 && raw.json.status === 'trash', `expected the post in the trash, got ${raw.http} ${raw.json && raw.json.status}`);
});

await scenario('Approved SEO fields reach the live page: one canonical, the meta description, the <title>', async () => {
  // Without the plugin's front-end output these are saved as post meta that WordPress never prints.
  const post = await newPost({ title: 'Front ' + uid(), content: 'Body' });
  const canonical = 'https://example.com/front-' + uid();
  check((await approveAndWrite((await submit({ resourceType: 'post', resourceId: post.id, action: 'update:canonical', proposal: { canonical } })).data)).http === 200, 'canonical write failed');
  const titleSeo = 'SEO <b>title</b> ' + uid();
  const w = await approveAndWrite((await submit({ resourceType: 'post', resourceId: post.id, action: 'update:onpage', proposal: { titleSeo, descriptionSeo: 'Meta "description" & more' } })).data);
  check(w.http === 200, `SEO write failed: ${w.http} ${w.text.slice(0, 160)}`);
  const html = await (await fetch(post.link)).text();
  const canon = [...html.matchAll(/<link rel=["']canonical["'] href=["']([^"']*)["']/g)].map((m) => m[1]);
  check(canon.length === 1 && canon[0] === canonical, 'canonical tags: ' + JSON.stringify(canon));
  check(html.includes('<meta name="description" content="Meta &quot;description&quot; &amp; more" />'), 'meta description missing or not escaped');
  check(html.includes('<title>' + titleSeo.replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</title>'), 'title tag: ' + ((html.match(/<title>([^<]*)<\/title>/) || [])[1]));
});

await scenario('The manifest tells the agent which fields each action can write', async () => {
  const m = (await call('GET', '/manifest', READ)).data;
  const f = m && m.fields;
  check(f && Array.isArray(f['update:onpage']) && f['update:onpage'].includes('titleSeo') && Array.isArray(f['delete:post']), 'fields: ' + JSON.stringify(f).slice(0, 160));
  check(Object.keys(f).sort().join() === m.actions.slice().sort().join(), 'fields and actions list different actions');
});

await scenario('Invalid JSON gets the spec envelope, not WordPress\'s own error shape', async () => {
  const res = await fetch(base + '/proposals', { method: 'POST', headers: { ...WRITE, 'Content-Type': 'application/json' }, body: '{"a":' });
  const json = await res.json();
  check(res.status === 400 && json.success === false && json.error.code === 'BAD_REQUEST', `got ${res.status} ${JSON.stringify(json).slice(0, 120)}`);
});

await scenario('No CORS headers are sent to a foreign Origin', async () => {
  const res = await fetch(base + '/ping', { headers: { Origin: 'https://evil.example' } });
  check(!res.headers.get('access-control-allow-origin'), 'Access-Control-Allow-Origin: ' + res.headers.get('access-control-allow-origin'));
});

let failed = 0;
for (const [ok, name, why] of results) {
  console.log(`[${ok ? '  ok  ' : ' FAIL '}] ${name}${ok ? '' : '\n          ' + why}`);
  if (!ok) failed += 1;
}
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
