/**
 * Differential fuzzer: sends the same generated requests (hostile paths, queries, headers and JSON bodies) to several
 * implementations of the contract and reports every request they answer differently.
 *
 *   node conformance/fuzz.mjs --config a.json --config b.json [--config c.json ...]
 *        [--seed 1] [--cases 500] [--only submitBody,readPath] [--parallel 4] [--examples 3]
 *        [--replay 1:342] [--no-shrink] [--json report.json]
 *
 * Same seed, same requests: a finding prints its id (seed:index), and --replay runs just that request again.
 * Local test targets only: it submits, approves and writes thousands of rows.
 */
import fs from 'node:fs';
import { buildConfig, isLocal } from './config.mjs';
import { runFuzz, groupFindings } from './fuzz/run.mjs';
import { FAMILIES } from './fuzz/families.mjs';

const argv = process.argv.slice(2);
const files = [];
const opt = {};
for (let i = 0; i < argv.length; i += 1) {
  const a = argv[i];
  if (a === '--config') files.push(argv[++i]);
  else if (a === '--no-shrink') opt.noShrink = true;
  else if (a.startsWith('--')) opt[a.slice(2)] = argv[++i];
  else { console.error('Unexpected argument: ' + a); process.exit(2); }
}
if (files.length < 2) { console.error('usage: node conformance/fuzz.mjs --config a.json --config b.json [...] [--seed N] [--cases N] [--only family,...] [--replay seed:index]\nfamilies: ' + Object.keys(FAMILIES).join(', ')); process.exit(2); }

const configs = files.map((f) => buildConfig({ config: f }));
for (const c of configs) if (!isLocal(c.baseUrl)) { console.error('Refusing non-local target ' + c.baseUrl); process.exit(2); }
const names = files.map((f) => f.replace(/^.*\//, '').replace(/\.json$/, '').replace(/\.local$/, ''));

let seed = Number(opt.seed ?? 1);
let indices = null;
if (opt.replay) {
  const [s, i] = opt.replay.split(':').map(Number);
  seed = s; indices = [i];
}
const only = opt.only ? opt.only.split(',') : null;
const started = Date.now();
const report = await runFuzz({
  configs, names, seed, cases: Number(opt.cases ?? 500), only, indices, parallel: Number(opt.parallel ?? 4), shrink: !opt.noShrink,
  onProgress: (s) => process.stderr.write(`\r${s.cases} cases, ${s.disagreements} disagreements, ${s.serverErrors} server errors   `)
});
process.stderr.write('\r' + ' '.repeat(70) + '\r');

const { stats } = report;
console.log(`fuzz seed=${seed} cases=${stats.cases} targets: ${names.join(', ')}  (${((Date.now() - started) / 1000).toFixed(0)}s)`);
console.log('families: ' + Object.entries(stats.families).map(([k, v]) => `${k} ${v}`).join(', '));
console.log(`agree ${stats.agree}, disagreements ${stats.disagreements}, server errors ${stats.serverErrors}`);
if (stats.refusedByWebServer) console.log(`${stats.refusedByWebServer} answer(s) came from a web server in front of a CMS (a malformed % escape refused with its own 400) and were left out of the comparison`);
console.log('');

const examples = Number(opt.examples ?? 3);
for (const group of groupFindings(report.findings)) {
  console.log(`!! ${group.signature}   (${group.count} case${group.count === 1 ? '' : 's'})`);
  for (const f of group.examples.slice(0, examples)) {
    console.log(`   case ${f.id}${f.shrunk ? ' (shrunk)' : ''}: ${f.method} ${f.path || '(empty)'}  as ${f.who}${f.setup ? ', after a ' + f.setup + ' row' : ''}${f.contentType !== undefined ? ', content-type ' + JSON.stringify(f.contentType) : ''}${f.chunks ? ', ' + f.chunks + ' chunks' : ''}`);
    if (f.notes.length) console.log('     ' + f.notes.join(' | '));
    if (f.body) console.log('     body ' + (f.body.length > 600 ? f.body.slice(0, 600) + '...' : f.body));
    if (f.headers && Object.keys(f.headers).length) console.log('     headers ' + JSON.stringify(f.headers));
    for (const [label, line] of Object.entries(f.lines)) console.log(`       ${label.padEnd(24)} ${line.length > 300 ? line.slice(0, 300) + '...' : line}`);
  }
  console.log('');
}
if (opt.json) fs.writeFileSync(opt.json, JSON.stringify(report, null, 2));
process.exit(report.findings.length ? 1 : 0);
