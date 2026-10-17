import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { timedFetch } from '../../conformance/http.mjs';

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

test('a server that never answers is a failed request, not a hang', async () => {
  const silent = http.createServer(() => { /* accept the request and say nothing */ });
  const port = await listen(silent);
  try {
    const started = Date.now();
    const res = await timedFetch(`http://127.0.0.1:${port}/`, {}, 300);
    assert.equal(res.http, 0);
    assert.equal(res.failed, true);
    assert.match(res.text, /no response within/);
    assert.ok(Date.now() - started < 3000, 'gave up on time');
  } finally { silent.closeAllConnections(); silent.close(); }
});

test('a dropped connection is reported with its reason', async () => {
  const dropper = net.createServer((socket) => socket.destroy());
  const port = await listen(dropper);
  try {
    const res = await timedFetch(`http://127.0.0.1:${port}/`, {}, 2000);
    assert.equal(res.http, 0);
    assert.match(res.text, /connection failed/);
  } finally { dropper.close(); }
});

test('a normal answer comes back whole', async () => {
  const ok = http.createServer((req, res) => { res.writeHead(201, { 'X-A': 'b' }); res.end('{"x":1}'); });
  const port = await listen(ok);
  try {
    const res = await timedFetch(`http://127.0.0.1:${port}/`, {}, 2000);
    assert.deepEqual([res.http, res.text, res.failed, res.headers.get('x-a')], [201, '{"x":1}', false, 'b']);
  } finally { ok.close(); }
});
