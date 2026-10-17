/**
 * Decision notifications (docs/spec.md, "Decision notifications"): tell the agent that a person has decided.
 *
 * It is a nudge. The body names the request and its new state and nothing else, so a receiver that is a third-party
 * service learns no content, and a forged nudge can only make the agent do one extra GET. The receiver URL is set by
 * the operator of the CMS, never by the agent.
 */
import { createHmac, randomUUID } from 'node:crypto';

export const NOTIFY_TIMEOUT_MS = 3000;

/** The one body a notification has: compact JSON, this key order. */
export function decisionBody(row) {
  return JSON.stringify({ event: 'decision', approvalId: row.approvalId, status: row.status, decidedUtc: row.decidedUtc });
}

/** "sha256=" + lowercase hex HMAC-SHA256 of "<unix seconds>.<raw body>". */
export function signDelivery(secret, timestamp, body) {
  return 'sha256=' + createHmac('sha256', secret).update(timestamp + '.' + body).digest('hex');
}

/**
 * @param {object} options
 * @param {string} options.url          where to POST (http or https, no credentials in the URL)
 * @param {string} [options.secret]     shared secret; without one the delivery is unsigned
 * @param {number} [options.timeoutMs]  give up after this long (default 3000)
 * @param {object} [options.logger]     needs warn(); failures are reported here and nowhere else
 * @returns {{ signed: boolean, decided(row): Promise<void> }}  decided() never rejects
 */
export function createWebhookNotifier({ url, secret = '', timeoutMs = NOTIFY_TIMEOUT_MS, fetchImpl = globalThis.fetch, now = Date.now, logger = console } = {}) {
  let target;
  try { target = new URL(url); } catch { throw new TypeError('The webhook url is not a valid URL.'); }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') throw new TypeError('The webhook url must be http or https.');
  if (target.username || target.password) throw new TypeError('The webhook url must not carry a user name or password.');

  return {
    signed: Boolean(secret),
    async decided(row) {
      const body = decisionBody(row);
      const headers = { 'content-type': 'application/json', 'x-hermes-delivery': randomUUID() };
      if (secret) {
        const timestamp = String(Math.floor(now() / 1000));
        headers['x-hermes-timestamp'] = timestamp;
        headers['x-hermes-signature'] = signDelivery(secret, timestamp, body);
      }
      try {
        // Redirects are not followed: the receiver is where the operator said, not where an answer points.
        const res = await fetchImpl(target, { method: 'POST', headers, body, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
        if (res.body && typeof res.body.cancel === 'function') await res.body.cancel().catch(() => {});
        if (res.status >= 400) logger.warn('[approval-webhook] HRM-' + row.approvalId + ': the receiver answered ' + res.status);
      } catch (err) {
        const why = (err && err.cause && err.cause.code) || (err && err.name) || 'error';
        try { logger.warn('[approval-webhook] HRM-' + row.approvalId + ': not delivered (' + why + ')'); } catch { /* a broken logger must not matter */ }
      }
    }
  };
}
