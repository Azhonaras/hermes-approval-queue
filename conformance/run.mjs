#!/usr/bin/env node
/**
 * Conformance runner for any CMS that implements docs/spec.md.
 *   node conformance/run.mjs --config conformance/profiles/demo-cms.json
 * Exit code 0 = every MUST check passed. 1 = a MUST failed. 2 = bad usage.
 */
import fs from 'node:fs';
import { parseArgs, buildConfig, isLocal } from './config.mjs';
import { runSuite } from './suite.mjs';

const HELP = `Usage: node conformance/run.mjs --config <file.json> [options]

Target (or put these in the config file):
  --base <url>                Base URL of the approval API, e.g. https://staging.example.com/api/approvals
  --write-header "N: value"   The agent's write key header
  --read-header  "N: value"   The agent's read key header
  --review-header "N: value"  Manager session header(s); repeat for cookie + CSRF token
  --action / --scope          A valid action and scope of your profile
  --resource-type / --resource-id   A test resource that is safe to modify
  --payload '{"field":"v-{{uid}}"}' JSON payload; {{uid}} becomes unique per check
Optional:
  --other-action / --other-scope / --other-resource-id   Enables the "bound to one request" mismatch checks
  --delete-action             e.g. delete:post (checks that an empty payload is accepted)
  --verify-url <url> --verify-field <path> [--verify-header "N: v"]
                              Reads the CMS directly to prove it changed exactly once
  --expired-fixture '{...}'   A /writes body for a pre-seeded expired approval
  --notify-port <n>           Listen here for the CMS's decision notifications and run the notify group
  --notify-secret <text>      The secret the CMS signs them with (leave out when it sends them unsigned)
  --notify-host <address>     Address to listen on (default 127.0.0.1; 0.0.0.0 when the CMS runs on another machine)
  --only <prefix>             Run one group: doors, validation, lifecycle, binding, edge, concurrency, stress, effects, notify, hygiene
  --json <file>               Write the full report as JSON
  --strict                    Treat SHOULD failures as failures
  --yes                       Required for non-local targets: the suite creates real approval rows
`;

function icon(r) {
  if (r.outcome === 'pass') return '  ok  ';
  if (r.outcome === 'skip') return ' skip ';
  return r.level === 'must' ? ' FAIL ' : ' warn ';
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log(HELP); return 0; }
  const config = buildConfig(args);
  if (!isLocal(config.baseUrl) && !config.yes) {
    console.error(`Refusing to run against ${config.baseUrl}.\nThis suite creates, approves, rejects and executes real rows on the target, and changes "${config.resourceType}/${config.resourceId}".\nUse a staging copy and pass --yes.`);
    return 2;
  }
  console.log(`Target   ${config.baseUrl}\nResource ${config.resourceType}/${config.resourceId}  action ${config.action}\n`);
  const { results, summary } = await runSuite(config, {
    only: args.only,
    onResult: (r) => {
      console.log(`[${icon(r)}] ${r.id}  ${r.title}`);
      if (r.detail) console.log(`          ${r.detail}`);
    }
  });
  console.log(`\n${summary.passed} passed, ${summary.skipped} skipped, ${summary.mustFailed} MUST failed, ${summary.shouldFailed} warnings`);
  console.log(summary.conformant ? 'RESULT: conformant (every MUST check passed)' : 'RESULT: NOT conformant');
  if (args.json) fs.writeFileSync(args.json, JSON.stringify({ target: config.baseUrl, at: new Date().toISOString(), summary, results }, null, 2));
  return summary.conformant ? 0 : 1;
}

main().then((code) => process.exit(code), (err) => { console.error(err.message); process.exit(2); });
