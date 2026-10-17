/**
 * An HTTP/1.1 client that sends the request target exactly as given.
 *
 * fetch() and new URL() "normalize" a path before anything is sent: they resolve "/a/../b" and "%2e%2e", and turn "\" into
 * "/". That hides the paths a router most needs testing with. This helper appends `path` to the base URL's path verbatim.
 *
 * `chunks` (an array of Buffers) sends the body with Transfer-Encoding: chunked instead of Content-Length.
 *
 * Never throws: like timedFetch, a failure comes back as { http: 0, text: '<why>', failed: true }.
 */
import http from 'node:http';
import https from 'node:https';
import { DEFAULT_TIMEOUT_MS } from './http.mjs';

export function rawRequest(baseUrl, { method = 'GET', path = '', headers = {}, body, chunks, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => { if (!settled) { settled = true; clearTimeout(deadline); resolve(value); } };
    const fail = (why) => done({ http: 0, text: why, headers: new Headers(), failed: true });
    const deadline = setTimeout(() => { req?.destroy(); fail(`no response within ${Math.round(timeoutMs / 1000)}s`); }, timeoutMs);
    let req;
    try {
      const u = new URL(baseUrl);
      const send = u.protocol === 'https:' ? https : http;
      const payload = body === undefined ? undefined : Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
      // `chunks` sends the body with Transfer-Encoding: chunked (no Content-Length), one write per chunk.
      req = send.request({
        host: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80), method,
        path: u.pathname.replace(/\/$/, '') + path,
        headers: { Connection: 'close', ...headers, ...(payload ? { 'Content-Length': String(payload.length) } : {}) },
        agent: false
      }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('error', (e) => fail('connection failed: ' + (e.code || e.message)));
        res.on('end', () => {
          const out = new Headers();
          for (const [k, v] of Object.entries(res.headers)) for (const item of [].concat(v)) out.append(k, item);
          done({ http: res.statusCode, text: Buffer.concat(chunks).toString('utf8'), headers: out, failed: false });
        });
      });
      req.on('error', (e) => fail('connection failed: ' + (e.code || e.message)));
      if (chunks) { for (const chunk of chunks) req.write(chunk); req.end(); } else req.end(payload);
    } catch (e) {
      fail('could not send: ' + (e.code || e.message));
    }
  });
}
