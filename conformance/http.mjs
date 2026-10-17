/**
 * One HTTP helper for the whole suite. A black-box test must never wait forever on the system under test:
 * a server that deadlocks or drops a request is a finding, not a reason for the run to hang.
 *
 * Never throws. A request that gets no answer in time, or whose connection breaks, comes back as
 * { http: 0, text: '<why>', failed: true }, which every check already treats as "not the expected status".
 */
export const DEFAULT_TIMEOUT_MS = 30000;

export async function timedFetch(url, init = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    const text = await res.text();
    return { http: res.status, text, headers: res.headers, failed: false };
  } catch (err) {
    const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    const why = timedOut ? `no response within ${Math.round(timeoutMs / 1000)}s` : 'connection failed: ' + (err && (err.cause?.code || err.message) || err);
    return { http: 0, text: why, headers: new Headers(), failed: true };
  }
}
