/** Turns CLI flags, an optional JSON file and defaults into one validated config object. */
import fs from 'node:fs';

const REPEATABLE = new Set(['review-header', 'verify-header']);
const BOOLEAN = new Set(['yes', 'strict', 'help']);

export function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) throw new Error('Unexpected argument: ' + arg);
    const name = arg.slice(2);
    if (BOOLEAN.has(name)) { out[name] = true; continue; }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error('Missing value for --' + name);
    i += 1;
    if (REPEATABLE.has(name)) (out[name] = out[name] || []).push(value);
    else out[name] = value;
  }
  return out;
}

const FILE_KEYS = {
  base: 'baseUrl', 'write-header': 'writeHeader', 'read-header': 'readHeader', 'review-header': 'reviewHeaders',
  action: 'action', scope: 'scope', 'resource-type': 'resourceType', 'resource-id': 'resourceId',
  'other-resource-id': 'otherResourceId', 'site-id': 'siteId', payload: 'payload',
  'other-action': 'otherAction', 'other-scope': 'otherScope', 'delete-action': 'deleteAction',
  'verify-url': 'verifyUrl', 'verify-field': 'verifyField', 'verify-header': 'verifyHeaders',
  'expired-fixture': 'expiredFixture', 'failing-payload': 'failingPayload', 'timeout-ms': 'timeoutMs'
};

const numeric = (v) => (typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : v);

export function buildConfig(args, readFile = (p) => fs.readFileSync(p, 'utf8')) {
  const fromFile = args.config ? JSON.parse(readFile(args.config)) : {};
  const merged = { ...fromFile };
  for (const [flag, key] of Object.entries(FILE_KEYS)) if (args[flag] !== undefined) merged[key] = args[flag];
  for (const key of ['payload', 'expiredFixture', 'failingPayload']) {
    if (typeof merged[key] === 'string') merged[key] = JSON.parse(merged[key]);
  }
  for (const key of ['resourceId', 'otherResourceId', 'siteId', 'timeoutMs']) merged[key] = numeric(merged[key]);

  const config = { siteId: 1, reviewHeaders: [], verifyHeaders: [], ...merged };
  config.otherResourceId ??= typeof config.resourceId === 'number' ? config.resourceId + 1000003 : config.resourceId + '-other';
  config.yes = Boolean(args.yes);
  config.strict = Boolean(args.strict);

  const notify = { ...(fromFile.notify || {}) };
  if (args['notify-port'] !== undefined) notify.port = args['notify-port'];
  if (args['notify-secret'] !== undefined) notify.secret = args['notify-secret'];
  if (args['notify-host'] !== undefined) notify.host = args['notify-host'];
  if (Object.keys(notify).length) {
    notify.port = numeric(notify.port);
    if (!Number.isInteger(notify.port) || notify.port < 1 || notify.port > 65535) throw new Error('notify.port must be a port number from 1 to 65535 (the port the CMS sends its decision notifications to)');
    notify.secret = notify.secret === undefined ? '' : String(notify.secret);
    notify.host = notify.host === undefined ? '127.0.0.1' : String(notify.host);
    config.notify = notify;
  } else {
    delete config.notify;
  }

  const missing = ['baseUrl', 'writeHeader', 'readHeader', 'action', 'scope', 'resourceType', 'resourceId', 'payload']
    .filter((k) => config[k] === undefined || config[k] === '');
  if (!config.reviewHeaders.length) missing.push('reviewHeaders');
  if (missing.length) throw new Error('Missing settings: ' + missing.join(', ') + '. See conformance/README.md');
  if (config.verifyUrl && !config.verifyField) throw new Error('--verify-url also needs --verify-field');
  if (typeof config.payload !== 'object' || Array.isArray(config.payload) || !JSON.stringify(config.payload).includes('{{uid}}')) {
    throw new Error('--payload must be a JSON object containing "{{uid}}" so every check sends a unique value');
  }
  return config;
}

export function isLocal(baseUrl) {
  const host = new URL(baseUrl).hostname;
  return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(host);
}
