import test from 'node:test';
import assert from 'node:assert/strict';
import { apiKeyAgentDoor, headerReviewerDoor } from '../../src/server/http/doors.mjs';

test('agent door separates read and write keys', () => {
  const door = apiKeyAgentDoor({ readKeys: ['r'], writeKeys: ['w'] });
  assert.deepEqual(door({ headers: { 'x-api-key': 'r' } }), { read: true, write: false });
  assert.deepEqual(door({ headers: { 'x-api-key': 'w' } }), { read: true, write: true });
  assert.deepEqual(door({ headers: { 'x-api-key': 'x' } }), { read: false, write: false });
  assert.deepEqual(door({ headers: {} }), { read: false, write: false });
});

test('reviewer door maps a session to an id and never accepts an API key', () => {
  const door = headerReviewerDoor({ sessions: { s1: 'alice' } });
  assert.deepEqual(door({ headers: { 'x-review-session': 's1' } }), { id: 'alice' });
  assert.equal(door({ headers: { 'x-review-session': 's2' } }), null);
  assert.equal(door({ headers: { 'x-api-key': 's1' } }), null);
});
