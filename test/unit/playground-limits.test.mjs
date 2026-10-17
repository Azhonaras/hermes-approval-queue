import test from 'node:test';
import assert from 'node:assert/strict';
import { isPlaygroundLimit } from '../../ports/php/wordpress/test/playground-limits.mjs';

const hostile = (detail) => ({ id: 'edge.hostile-requests-never-5xx', detail });

test('the two Playground HTTP-layer 500s on a malformed percent-escape are recognised', () => {
  assert.equal(isPlaygroundLimit(hostile('1 request(s) gave a 5xx: GET /%ff%fe  -> 500')), true);
  for (const label of ['malformed escape', 'lone percent sign', 'bytes that are not UTF-8']) {
    assert.equal(isPlaygroundLimit({ id: 'edge.path-rules', detail: `${label}: expected HTTP 400, got 500 — Internal Server Error` }), true, label);
  }
});

test('a malformed escape that Playground answers with 500 before the door check is recognised too', () => {
  const doors = (detail) => ({ id: 'doors.door-comes-first', detail });
  const head = 'these answered the input instead of the door (want 401 or 403): ';
  assert.equal(isPlaygroundLimit(doors(head + 'none GET /resources/article/%zz -> 500; write GET /resources/post/%zz -> 500')), true);
  assert.equal(isPlaygroundLimit(doors(head + 'none GET /resources/post/%zz -> 500')), true);
  assert.equal(isPlaygroundLimit(doors(head + 'none POST /proposals -> 400')), false);
  assert.equal(isPlaygroundLimit(doors(head + 'none GET /proposals/%zz -> 200')), false);
  assert.equal(isPlaygroundLimit(doors(head + 'none GET /proposals/%zz -> 500; none POST /proposals -> 500')), false);
});

test('a 5xx on any other request, or any other check, is a real failure', () => {
  assert.equal(isPlaygroundLimit(hostile('1 request(s) gave a 5xx: POST /proposals  -> 500')), false);
  assert.equal(isPlaygroundLimit(hostile('2 request(s) gave a 5xx: GET /%ff%fe  -> 500 | POST /proposals {"a" -> 500')), false);
  assert.equal(isPlaygroundLimit(hostile('1 request(s) gave a 5xx: GET /%ff%fe  -> 0')), false, 'no response at all is not the known 500');
  assert.equal(isPlaygroundLimit({ id: 'edge.path-rules', detail: 'plus sign: expected HTTP 404, got 500 — x' }), false);
  assert.equal(isPlaygroundLimit({ id: 'edge.path-rules', detail: 'malformed escape: expected HTTP 400, got 200 — ok' }), false);
  assert.equal(isPlaygroundLimit({ id: 'doors.ping-open', detail: 'GET /%ff%fe  -> 500' }), false);
  assert.equal(isPlaygroundLimit({ id: 'edge.path-rules' }), false);
});
