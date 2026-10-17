import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { readJson } from '../../src/server/http/body.mjs';

const JSON_TYPE = { 'content-type': 'application/json; charset=utf-8' };
const request = (text, extra = {}) => Object.assign(Readable.from(text === undefined ? [] : [Buffer.from(text, 'utf8')]), { headers: JSON_TYPE }, extra);
const code = (c) => (e) => e.code === c;

test('a streamed body is parsed strictly', async () => {
  assert.deepEqual(await readJson(request('{"a":[1,2,{"b":null}]}')), { a: [1, 2, { b: null }] });
  assert.deepEqual(await readJson(request(undefined)), {}, 'no body at all is an empty object');
  await assert.rejects(readJson(request('{"a":1,"a":2}')), code('BAD_REQUEST'));
  await assert.rejects(readJson(request('[]')), code('BAD_REQUEST'));
  await assert.rejects(readJson(request('null')), code('BAD_REQUEST'));
  await assert.rejects(readJson(request('"text"')), code('BAD_REQUEST'));
  await assert.rejects(readJson(request('{"a":' + '9'.repeat(30) + '}')), code('BAD_REQUEST'));
});

test('the body must be application/json (415), but an empty body needs no Content-Type', async () => {
  const typed = (type, text) => request(text, { headers: type === undefined ? {} : { 'content-type': type } });
  for (const type of ['application/json', 'APPLICATION/JSON', 'application/json;charset=utf-8', ' application/json ; charset=utf-8']) {
    assert.deepEqual(await readJson(typed(type, '{"a":1}')), { a: 1 }, type);
  }
  for (const type of ['text/plain', 'multipart/form-data; boundary=x', 'application/x-www-form-urlencoded', 'application/vnd.api+json', 'application/jsonx', 'json', '']) {
    await assert.rejects(readJson(typed(type, '{"a":1}')), code('UNSUPPORTED_MEDIA_TYPE'), JSON.stringify(type));
    await assert.rejects(readJson(typed(type, undefined)), code('UNSUPPORTED_MEDIA_TYPE'), JSON.stringify(type) + ' with an empty body');
  }
  await assert.rejects(readJson(typed(undefined, '{"a":1}')), code('UNSUPPORTED_MEDIA_TYPE'), 'a body without any Content-Type');
  assert.deepEqual(await readJson(typed(undefined, undefined)), {}, 'no body and no Content-Type is an empty object');
});

test('a body larger than the limit is 413, not a crash', async () => {
  await assert.rejects(readJson(request('{"a":"' + 'x'.repeat(300) + '"}'), { limit: 100 }), code('PAYLOAD_TOO_LARGE'));
});

test('a body a framework already parsed is used, but only if it is an object', async () => {
  const parsed = { a: 1 };
  assert.equal(await readJson(request(undefined, { body: parsed })), parsed);
  // These used to leave the request hanging forever: the stream is spent, so there is nothing left to wait for.
  for (const body of ['text', 7, true, null, []]) {
    await assert.rejects(readJson(request(undefined, { body })), code('BAD_REQUEST'), 'pre-parsed ' + JSON.stringify(body));
  }
});

test('a stream somebody else already consumed is refused instead of awaited', async () => {
  const req = request('{"a":1}');
  for await (const chunk of req) void chunk; // a middleware that read the body and stored it nowhere
  await assert.rejects(readJson(req), code('BAD_REQUEST'));
});
