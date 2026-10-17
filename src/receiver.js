'use strict';
/**
 * Agent side of decision notifications (docs/spec.md, "Decision notifications"). Node 18+, no dependencies.
 *
 *   const { createReceiver } = require('./receiver.js');
 *   const receiver = await createReceiver({
 *     port: 8795, secret: process.env.WEBHOOK_SECRET,
 *     onDecision: ({ approvalId, status }) => { ... agent.get(approvalId) ... }
 *   });
 *
 * A notification is a nudge: it says "look at approval N", nothing more. Always read the row with your own key, and
 * keep a slow poll (agent.waitForDecision) as the safety net, because a notification is sent at most once.
 */
const http = require('node:http');
const { createHmac, timingSafeEqual } = require('node:crypto');

const MAX_BODY_BYTES = 4096; // a notification is about 100 bytes
const STATUSES = ['Approved', 'Rejected', 'ChangesRequested'];

function signature(secret, timestamp, rawBody) {
  return 'sha256=' + createHmac('sha256', secret).update(timestamp + '.' + rawBody).digest('hex');
}

/**
 * Checks the proof of origin. Without a secret there is none: { ok: true, signed: false }, and the caller must treat
 * the nudge as a hint only. With one, the HMAC over the raw bytes and a timestamp within five minutes are required.
 */
function verifyDelivery({ secret, headers, rawBody, now = Date.now, toleranceSeconds = 300 }) {
  if (!secret) return { ok: true, signed: false };
  const timestamp = String(headers['x-hermes-timestamp'] || '');
  const given = String(headers['x-hermes-signature'] || '');
  if (!/^\d{1,12}$/.test(timestamp)) return { ok: false, reason: 'missing or malformed X-Hermes-Timestamp' };
  if (Math.abs(now() / 1000 - Number(timestamp)) > toleranceSeconds) return { ok: false, reason: 'timestamp is too far from this clock' };
  const want = Buffer.from(signature(secret, timestamp, rawBody));
  const have = Buffer.from(given);
  if (want.length !== have.length || !timingSafeEqual(want, have)) return { ok: false, reason: 'signature does not match' };
  return { ok: true, signed: true };
}

/** The body as a plain object, or null when it is not a decision notification this receiver understands. */
function parseDecision(rawBody) {
  let data;
  try { data = JSON.parse(rawBody); } catch { return null; }
  if (!data || typeof data !== 'object' || Array.isArray(data) || data.event !== 'decision') return null;
  if (!Number.isInteger(data.approvalId) || !STATUSES.includes(data.status) || typeof data.decidedUtc !== 'string') return null;
  return { approvalId: data.approvalId, status: data.status, decidedUtc: data.decidedUtc };
}

function reply(res, status) {
  res.writeHead(status, { 'Content-Length': '0', Connection: 'close' });
  res.end();
}

/**
 * Starts a small HTTP server for the CMS to call. Resolves to { server, port, url, close() }.
 * @param {object} options
 * @param {number} [options.port]      0 picks a free port
 * @param {string} [options.host]      127.0.0.1 unless the CMS is on another machine
 * @param {string} [options.path]      the path the CMS posts to
 * @param {string} [options.secret]    the shared secret; unsigned nudges are refused when this is set
 * @param {function} options.onDecision  ({ approvalId, status, decidedUtc }, { signed, delivery }) called once per delivery
 */
function createReceiver({ port = 0, host = '127.0.0.1', path = '/hook', secret = '', onDecision, logger = console } = {}) {
  if (typeof onDecision !== 'function') throw new TypeError('onDecision must be a function');
  const seen = new Set();
  const server = http.createServer((req, res) => {
    if (req.url.split('?')[0] !== path) return reply(res, 404);
    if (req.method !== 'POST') return reply(res, 405);
    const chunks = [];
    let size = 0;
    let tooBig = false;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) tooBig = true; else chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooBig) return reply(res, 413);
      const rawBody = Buffer.concat(chunks).toString('utf8');
      const proof = verifyDelivery({ secret, headers: req.headers, rawBody });
      if (!proof.ok) { logger.warn('[approval-receiver] refused a notification: ' + proof.reason); return reply(res, 401); }
      const decision = parseDecision(rawBody);
      if (!decision) return reply(res, 400);
      reply(res, 204); // answer first: the CMS does not wait for the agent's work
      const delivery = String(req.headers['x-hermes-delivery'] || '');
      if (delivery) {
        if (seen.has(delivery)) return;
        seen.add(delivery);
        if (seen.size > 200) seen.delete(seen.values().next().value);
      }
      Promise.resolve()
        .then(() => onDecision(decision, { signed: proof.signed, delivery }))
        .catch((err) => logger.warn('[approval-receiver] onDecision failed: ' + (err && err.message ? err.message : err)));
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const bound = server.address().port;
      resolve({
        server,
        port: bound,
        url: 'http://' + (host.includes(':') ? '[' + host + ']' : host) + ':' + bound + path,
        close: () => new Promise((done) => { server.close(() => done()); if (server.closeAllConnections) server.closeAllConnections(); })
      });
    });
  });
}

module.exports = { createReceiver, verifyDelivery, parseDecision, signature };
