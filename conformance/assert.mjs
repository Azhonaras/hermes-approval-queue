export class CheckFailure extends Error {}

export function expect(cond, message) {
  if (!cond) throw new CheckFailure(message);
}
export function expectStatus(res, http, what) {
  expect(res.http === http, `${what}: expected HTTP ${http}, got ${res.http}${res.text ? ' — ' + res.text.slice(0, 160) : ''}`);
}
export function expectCode(ctx, res, http, code, what) {
  expectStatus(res, http, what);
  expect(ctx.code(res) === code, `${what}: expected error code ${code}, got ${ctx.code(res)}`);
}
/** Accepts any of several HTTP statuses (e.g. 401 or 403 for "no credentials"). */
export function expectOneOf(res, statuses, what) {
  expect(statuses.includes(res.http), `${what}: expected HTTP ${statuses.join(' or ')}, got ${res.http}`);
}
/**
 * The guard let the write through: 200, or 502 WRITE_FAILED when the CMS itself refused a field the check
 * had to add (a CMS that whitelists fields will not save "aa_first" or "n"). A 409 means the guard refused it.
 */
export function expectGuardPassed(ctx, res, what) {
  const passed = res.http === 200 || (res.http === 502 && ctx.code(res) === 'WRITE_FAILED');
  expect(passed, `${what}: the guard should accept this write (200, or 502 WRITE_FAILED from the CMS), got ${res.http}${res.text ? ' — ' + res.text.slice(0, 160) : ''}`);
}
