/**
 * Doors decide who is calling. A CMS plugs in its own:
 *
 *   agent(req)    -> { read: boolean, write: boolean }   (API keys)
 *   reviewer(req) -> { id: string } | null               (your logged-in manager session)
 *
 * The reviewer door must come from the CMS session (cookie + role check),
 * never from anything the agent can hold.
 */
import { timingSafeEqual } from 'node:crypto';

function safeEqual(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Static API keys, e.g. from environment variables. */
export function apiKeyAgentDoor({ readKeys = [], writeKeys = [], header = 'x-api-key' }) {
  return (req) => {
    const key = req.headers[header];
    const write = writeKeys.some((k) => safeEqual(key, k));
    const read = write || readKeys.some((k) => safeEqual(key, k));
    return { read, write };
  };
}

/** Demo-only reviewer door: a fixed header value maps to a reviewer id. */
export function headerReviewerDoor({ sessions, header = 'x-review-session' }) {
  return (req) => {
    const value = req.headers[header];
    const match = Object.keys(sessions).find((s) => safeEqual(value, s));
    return match ? { id: sessions[match] } : null;
  };
}
