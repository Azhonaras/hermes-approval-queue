/**
 * Runs generated requests against several implementations of the contract and reports where they disagree.
 * Two implementations that read the same bytes differently cannot both be right, so a disagreement is a bug in one of them.
 * A 5xx or a dropped connection is a finding even when every implementation agrees on it.
 */
import { makeCase } from './families.mjs';
import { makeTarget, WEB_SERVER_REFUSED } from './target.mjs';

const isServerError = (line) => /^5\d\d /.test(line) || line.startsWith('NO-RESPONSE');
const coarse = (line) => line.split(' ').slice(0, 2).join(' ');

export function showBody(buf) {
  if (!buf) return '';
  const text = buf.toString('utf8');
  if (Buffer.from(text, 'utf8').equals(buf)) return JSON.stringify(text);
  return '0x' + buf.toString('hex').slice(0, 400);
}

async function runAll(targets, spec) {
  const results = await Promise.all(targets.map((t) => t.run(spec).catch((e) => ({ line: 'HARNESS-ERROR ' + e.message.slice(0, 80) }))));
  return Object.fromEntries(targets.map((t, i) => [t.label, results[i].line]));
}

function classify(lines) {
  // A web server's own refusal says nothing about the CMS behind it: the targets that did answer still have to agree.
  const answered = Object.values(lines).filter((l) => l !== WEB_SERVER_REFUSED);
  if (answered.some((l) => l !== answered[0])) return 'disagreement';
  if (answered.some(isServerError)) return 'server-error';
  return null;
}

export async function runFuzz({ configs, names, seed = 1, cases = 500, only = null, parallel = 4, indices = null, shrink = true, onProgress = () => {} }) {
  const targets = configs.map((c, i) => makeTarget(c, names[i]));
  const list = indices ?? Array.from({ length: cases }, (_, i) => i);
  const stats = { cases: 0, families: {}, agree: 0, disagreements: 0, serverErrors: 0, refusedByWebServer: 0 };
  const findings = [];
  let next = 0;

  async function one(index) {
    const made = makeCase(seed, index, only);
    let spec = made.build();
    let lines = await runAll(targets, spec);
    stats.cases += 1;
    stats.families[made.family] = (stats.families[made.family] || 0) + 1;
    stats.refusedByWebServer += Object.values(lines).filter((l) => l === WEB_SERVER_REFUSED).length;
    const kind = classify(lines);
    if (!kind) { stats.agree += 1; return; }
    if (kind === 'disagreement') stats.disagreements += 1; else stats.serverErrors += 1;

    let shrunk = false;
    if (shrink && spec.mutationCount > 1) {
      const keep = Array.from({ length: spec.mutationCount }, () => true);
      for (let j = 0; j < keep.length; j += 1) {
        keep[j] = false;
        const trial = made.build(keep);
        const trialLines = await runAll(targets, trial);
        if (classify(trialLines) === kind) { spec = trial; lines = trialLines; shrunk = true; } else keep[j] = true;
      }
    }
    findings.push({
      id: spec.id, family: made.family, kind, shrunk, notes: spec.notes, method: spec.method, who: spec.who, setup: spec.setup,
      path: spec.path, body: showBody(spec.body), chunks: spec.chunks ? spec.chunks.length : undefined, contentType: spec.contentType, headers: spec.headers, lines,
      signature: kind + ' ' + made.family + ' ' + Object.entries(lines).map(([k, v]) => `${k}=${coarse(v)}`).join(' ')
    });
  }

  async function worker() {
    for (;;) {
      const k = next; next += 1;
      if (k >= list.length) return;
      await one(list[k]);
      if (stats.cases % 100 === 0) onProgress(stats);
    }
  }
  await Promise.all(Array.from({ length: parallel }, worker));
  findings.sort((a, b) => a.signature.localeCompare(b.signature) || a.id.localeCompare(b.id, undefined, { numeric: true }));
  return { seed, targets: names, stats, findings };
}

/** Groups findings by what went wrong (family + each target's status/code), so one bug is one entry with a count. */
export function groupFindings(findings) {
  const groups = new Map();
  for (const f of findings) {
    if (!groups.has(f.signature)) groups.set(f.signature, []);
    groups.get(f.signature).push(f);
  }
  return [...groups.entries()].map(([signature, items]) => ({ signature, count: items.length, examples: items }));
}
