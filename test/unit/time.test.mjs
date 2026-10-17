import test from 'node:test';
import assert from 'node:assert/strict';
import { utcMillis } from '../../src/server/core/time.mjs';
import { isExpired } from '../../src/server/core/guard.mjs';

test('UTC instants are read with or without a fraction', () => {
  assert.equal(utcMillis('2026-10-14T21:25:31Z'), Date.UTC(2026, 9, 14, 21, 25, 31));
  assert.equal(utcMillis('2026-10-14T21:25:31.5Z'), Date.UTC(2026, 9, 14, 21, 25, 31, 500));
  assert.equal(utcMillis('2026-10-14T21:25:31.123456Z'), Date.UTC(2026, 9, 14, 21, 25, 31, 123));
  assert.equal(utcMillis(new Date(Date.UTC(2026, 0, 1))), Date.UTC(2026, 0, 1));
});

test('anything that is not a UTC instant throws instead of guessing', () => {
  // Without "Z", Date.parse would read local time: an expiry off by the server's UTC offset.
  for (const bad of ['2026-10-14 21:25:31', '2026-10-14T21:25:31', '2026-02-30T00:00:00Z', '', 'soon', null, undefined, 1792013131000, new Date(NaN)]) {
    assert.throws(() => utcMillis(bad), /Unreadable/, JSON.stringify(bad));
  }
});

test('a row without a readable expiry is an error, never "does not expire"', () => {
  const now = Date.UTC(2026, 0, 1);
  assert.equal(isExpired({ expiresUtc: '2025-12-31T23:59:59.999Z' }, now), true);
  assert.equal(isExpired({ expiresUtc: '2026-01-01T00:00:00.001Z' }, now), false);
  assert.throws(() => isExpired({ expiresUtc: null }, now), /Unreadable expiresUtc/);
  assert.throws(() => isExpired({ expiresUtc: 'garbage' }, now), /Unreadable expiresUtc/);
});
