/**
 * Request families. Each family turns a seeded random generator into one request spec:
 *
 *   { family, notes[], setup: null|'pending'|'approved', who, method, path, body, contentType, headers, chunks, compare }
 *
 * Path, header and body text may contain {{type}} {{rid}} {{approvalId}} {{readKey}} {{writeKey}}: each target fills in its own.
 * `keep` (an array of booleans, or null for all) switches individual mutations off, which is how a finding is shrunk.
 */
import { caseRng } from './rng.mjs';
import { obj, render, chooseMutations } from './body.mjs';
import { SEGMENT_TOKENS, QUERY_VALUES, QUERY_NAMES, NUMBERS, STRINGS } from './pools.mjs';

const submissionTree = () => obj([
  ['siteId', '1'], ['resourceType', '"article"'], ['resourceId', '42'], ['action', '"update:canonical"'], ['scope', '"seo:write"'],
  ['reason', '"fuzz"'], ['proposal', obj([['canonical', '"https://example.com/fuzz"']])]
]);
export const SUBMISSION_BYTES = Buffer.from(JSON.stringify({
  siteId: 1, resourceType: 'article', resourceId: 42, action: 'update:canonical', scope: 'seo:write', reason: 'fuzz', proposal: { canonical: 'https://example.com/fuzz' }
}), 'utf8');

const writeTree = () => obj([
  ['approvalId', '{{approvalId}}'], ['resourceType', '"article"'], ['resourceId', '42'], ['action', '"update:canonical"'], ['scope', '"seo:write"'],
  ['proposal', obj([['canonical', '"https://example.com/fuzz"']])]
]);

const decisionTree = (rng) => rng.weighted([
  [4, () => obj([['reason', '"fuzz reason"']])],
  [2, () => obj([['reason', '""']])],
  [2, () => obj([['reason', '""'], ['proposal', obj([['canonical', '"https://example.com/edited"']])]])],
  [1, () => obj([])]
])();

/** Mutates a tree 1-3 times (or as `keep` says) and returns the body bytes and what was done. */
function mutated(rng, root, keep, max = 3) {
  const count = rng.between(1, max);
  const all = chooseMutations(rng, root, count);
  const used = all.filter((_, i) => !keep || keep[i]);
  const { bytes, notes } = render(root, used);
  return { bytes, notes, count };
}

/** A path segment or query fragment: a known-good token with something appended, prepended, or replaced by a pool entry. */
function segment(rng, good) {
  return rng.weighted([
    [3, () => good],
    [3, () => good + rng.pick(SEGMENT_TOKENS)],
    [2, () => rng.pick(SEGMENT_TOKENS) + good],
    [3, () => rng.pick(SEGMENT_TOKENS)],
    [1, () => rng.pick(SEGMENT_TOKENS) + rng.pick(SEGMENT_TOKENS)],
    [1, () => good.slice(0, rng.int(good.length + 1)) + rng.pick(SEGMENT_TOKENS) + good.slice(rng.int(good.length + 1))]
  ])();
}

function query(rng, names = ['siteId', 'status']) {
  const parts = Array.from({ length: rng.between(0, 3) }, () => {
    const name = rng.chance(0.7) ? rng.pick(names) : rng.pick(QUERY_NAMES);
    return rng.chance(0.1) ? name : name + '=' + rng.pick(QUERY_VALUES);
  });
  if (rng.chance(0.1)) parts.splice(rng.int(parts.length + 1), 0, '');
  return parts.length ? '?' + parts.join(rng.chance(0.9) ? '&' : rng.pick([';', '&&', '&amp;'])) : (rng.chance(0.1) ? '?' : '');
}

const WHO_AGENT = [[8, 'read'], [1, 'none'], [1, 'write']];
const KEY_VARIANTS = ['{{k}}', '{{k}}x', 'x{{k}}', '{{K}}', '{{k}},{{k}}', '', ' ', '{{k}}\t', '\t{{k}}', '{{k}} {{k}}', '"{{k}}"', 'Bearer {{k}}', '{{k}};'];

export const FAMILIES = {
  /** GET /resources/{type}/{id} with hostile path segments and queries (read door). */
  readPath(rng) {
    const type = rng.chance(0.6) ? '{{type}}' : segment(rng, '{{type}}');
    const id = segment(rng, '{{rid}}');
    const q = query(rng);
    return { notes: [`GET /resources/${type}/${id}${q}`], setup: null, who: rng.weighted(WHO_AGENT.map(([w, v]) => [w, v])), method: 'GET', path: `/resources/${type}/${id}${q}`, compare: 'status' };
  },

  /** GET /proposals?... (review door). */
  listQuery(rng) {
    const q = query(rng, ['status', 'siteId']);
    return { notes: [`GET /proposals${q}`], setup: null, who: rng.weighted([[8, 'review'], [1, 'write'], [1, 'read']]), method: 'GET', path: '/proposals' + q, compare: 'status' };
  },

  /** GET /proposals/{id} where the row exists, with hostile id spellings. */
  getProposal(rng) {
    const id = segment(rng, '{{approvalId}}');
    const q = rng.chance(0.2) ? query(rng) : '';
    return { notes: [`GET /proposals/${id}${q}`], setup: 'pending', who: rng.weighted(WHO_AGENT), method: 'GET', path: `/proposals/${id}${q}`, compare: 'echo' };
  },

  /** POST /proposals with a mutated submission body. */
  submitBody(rng, keep) {
    const { bytes, notes, count } = mutated(rng, submissionTree(), keep);
    const who = rng.weighted([[16, 'write'], [1, 'read'], [1, 'none'], [1, 'review'], [1, 'writeAndReview']]);
    return { notes, mutationCount: count, setup: null, who, method: 'POST', path: '/proposals', body: bytes, compare: 'echo' };
  },

  /** approve / reject / request-changes with a mutated decision body. */
  decideBody(rng, keep) {
    const verb = rng.pick(['approve', 'approve', 'reject', 'request-changes']);
    const { bytes, notes, count } = mutated(rng, decisionTree(rng), keep, 2);
    const who = rng.weighted([[14, 'review'], [2, 'write'], [1, 'none'], [1, 'writeAndReview'], [1, 'read']]);
    const id = rng.chance(0.85) ? '{{approvalId}}' : segment(rng, '{{approvalId}}');
    return { notes: [`POST /proposals/${id}/${verb}`, ...notes], mutationCount: count, setup: 'pending', who, method: 'POST', path: `/proposals/${id}/${verb}`, body: bytes, compare: 'echo' };
  },

  /** POST /writes with a mutated write body against an approved row: only the guard is under test. */
  writeBody(rng, keep) {
    const { bytes, notes, count } = mutated(rng, writeTree(), keep);
    const who = rng.weighted([[16, 'write'], [1, 'read'], [1, 'none'], [1, 'review']]);
    return { notes, mutationCount: count, setup: 'approved', who, method: 'POST', path: '/writes', body: bytes, compare: 'guard' };
  },

  /** Credential headers spelled in awkward ways. */
  headers(rng) {
    const door = rng.pick(['read', 'write']);
    const variant = rng.pick(KEY_VARIANTS);
    const name = rng.pick(['X-Api-Key', 'x-api-key', 'X-API-KEY', 'X-Api-Key ', 'X_Api_Key', 'Authorization']);
    const post = door === 'write';
    return {
      notes: [`${name}: ${JSON.stringify(variant)} (${door} key)`], setup: null, who: 'none', method: post ? 'POST' : 'GET', path: post ? '/proposals' : '/manifest',
      body: post ? SUBMISSION_BYTES : undefined, headers: { [name.trim()]: variant.replaceAll('{{k}}', door === 'write' ? '{{writeKey}}' : '{{readKey}}').replaceAll('{{K}}', door === 'write' ? '{{WRITEKEY}}' : '{{READKEY}}') },
      compare: 'status'
    };
  },

  /** Unusual methods on known routes. */
  methods(rng) {
    const method = rng.pick(['PUT', 'PATCH', 'DELETE', 'GET', 'POST']); // HEAD, OPTIONS, TRACE and made-up methods belong to the web server, not to the contract
    const path = rng.pick(['/ping', '/manifest', '/proposals', '/proposals/{{approvalId}}', '/proposals/{{approvalId}}/approve', '/writes', '/resources/{{type}}/{{rid}}', '/', '']);
    return { notes: [`${method} ${path || '(empty path)'}`], setup: 'pending', who: rng.pick(['writeAndReview', 'none', 'read']), method, path, compare: 'status' };
  },

  /** A valid submission sent with unusual Content-Type, chunking, or Expect headers. */
  framing(rng) {
    const contentType = rng.pick([undefined, null, 'text/plain', 'application/json; charset=ISO-8859-1', 'application/json; charset=utf-16', 'application/x-www-form-urlencoded',
      'multipart/form-data; boundary=x', 'application/JSON', 'APPLICATION/JSON; CHARSET=UTF-8', 'application/vnd.api+json', 'application/json;', 'json', '']);
    const chunked = rng.chance(0.4);
    const chunks = chunked ? splitInto(SUBMISSION_BYTES, rng) : undefined;
    const headers = rng.chance(0.15) ? { Expect: '100-continue' } : {};
    return { notes: [`content-type ${JSON.stringify(contentType)}${chunked ? ', chunked into ' + chunks.length : ''}${headers.Expect ? ', Expect' : ''}`],
      setup: null, who: 'write', method: 'POST', path: '/proposals', body: chunked ? undefined : SUBMISSION_BYTES, chunks, contentType, headers, compare: 'echo' };
  }
};

function splitInto(buf, rng) {
  const cuts = Array.from({ length: rng.between(1, 6) }, () => rng.int(buf.length)).sort((a, b) => a - b);
  const out = [];
  let from = 0;
  for (const cut of cuts) { out.push(buf.subarray(from, cut)); from = cut; }
  out.push(buf.subarray(from));
  return out.filter((c) => c.length);
}

export const FAMILY_WEIGHTS = {
  readPath: 14, listQuery: 6, getProposal: 8, submitBody: 34, decideBody: 14, writeBody: 14, headers: 4, methods: 3, framing: 3
};

/** The case at (seed, index): which family, and a builder that can rebuild it with some mutations switched off. */
export function makeCase(seed, index, only = null) {
  const names = Object.keys(FAMILIES).filter((n) => !only || only.includes(n));
  if (!names.length) throw new Error('No such family. Choose from: ' + Object.keys(FAMILIES).join(', '));
  const picker = caseRng(seed ^ 0x51ed270b, index);
  const family = picker.weighted(names.map((n) => [FAMILY_WEIGHTS[n], n]));
  const build = (keep = null) => ({ family, id: `${seed}:${index}`, ...FAMILIES[family](caseRng(seed, index), keep) });
  return { family, build };
}
