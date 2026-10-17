/**
 * The receiver the suite hosts for the `notify` checks (docs/spec.md, "Decision notifications").
 *
 * It records every POST it gets and can be told to misbehave, so a check can prove that a receiver which answers 500,
 * hangs, redirects or is not there at all never changes a decision. It is a test double, not the agent's receiver:
 * that one is src/receiver.js.
 *
 * Modes: 'ok' (204), 'error' (500), 'hang' (never answers until release()), 'redirect' (302 to /elsewhere), 'down'
 * (nothing is listening; set by down(), undone by up()).
 */
import http from 'node:http';

export async function startReceiver({ port = 0, host = '127.0.0.1' } = {}) {
  const deliveries = [];
  const hung = new Set();
  let mode = 'ok';
  let server;
  let boundPort = port;

  const handle = (req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      deliveries.push({
        at: Date.now(),
        method: req.method,
        path: req.url,
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8')
      });
      if (req.url.startsWith('/elsewhere')) { res.writeHead(204, { Connection: 'close' }); res.end(); return; }
      if (mode === 'error') { res.writeHead(500, { 'Content-Type': 'text/plain', Connection: 'close' }); res.end('receiver failure'); return; }
      if (mode === 'redirect') { res.writeHead(302, { Location: 'http://' + (host.includes(':') ? '[' + host + ']' : host) + ':' + boundPort + '/elsewhere', Connection: 'close' }); res.end(); return; }
      if (mode === 'hang') { hung.add(res); res.on('close', () => hung.delete(res)); return; }
      res.writeHead(204, { Connection: 'close' });
      res.end();
    });
  };

  const listen = () => new Promise((resolve, reject) => {
    server = http.createServer(handle);
    server.once('error', reject);
    server.listen(boundPort, host, () => { boundPort = server.address().port; resolve(); });
  });
  const stop = () => new Promise((resolve) => {
    if (!server) return resolve();
    const s = server;
    server = null;
    s.close(() => resolve());
    if (s.closeAllConnections) s.closeAllConnections();
  });

  await listen();

  const receiver = {
    host,
    get port() { return boundPort; },
    get mode() { return mode; },
    deliveries,

    /** 'ok' | 'error' | 'hang' | 'redirect'. Releases anything that was hanging when the mode changes. */
    setMode(next) { mode = next; if (next !== 'hang') receiver.release(); },
    /** Answers every hanging request (204) so the sender's socket is freed. */
    release() { for (const res of hung) { try { res.writeHead(204, { Connection: 'close' }); res.end(); } catch { /* already gone */ } } hung.clear(); },
    down: stop,
    up: async () => { if (!server) await listen(); },

    /** Notifications for one approval, parsed. The body is kept raw for the checks that compare bytes. */
    forApproval(approvalId) {
      return deliveries.filter((d) => {
        try { return d.path !== '/elsewhere' && JSON.parse(d.body).approvalId === approvalId; } catch { return false; }
      });
    },
    /** Resolves with the notifications for `approvalId` once at least `count` have arrived, or after `ms`. */
    async waitFor(approvalId, count = 1, ms = 5000) {
      const deadline = Date.now() + ms;
      while (Date.now() < deadline) {
        if (receiver.forApproval(approvalId).length >= count) break;
        await new Promise((r) => setTimeout(r, 25));
      }
      return receiver.forApproval(approvalId);
    },
    /** Waits a fixed time, then returns the notifications for `approvalId`: how a check proves that nothing was sent. */
    async quiet(approvalId, ms = 500) {
      await new Promise((r) => setTimeout(r, ms));
      return receiver.forApproval(approvalId);
    },
    elsewhere: () => deliveries.filter((d) => d.path.startsWith('/elsewhere')),

    async close() { receiver.release(); await stop(); }
  };
  return receiver;
}
