/**
 * Instants in approval rows are UTC: an ISO-8601 string ending in "Z" (fraction optional) or a Date.
 * Anything else means a store returned something it should not have, so it throws instead of guessing:
 * Date.parse would read "2026-10-14 21:25:31" as LOCAL time and "garbage" as NaN, which never compares as
 * expired, so an approval would silently live forever or expire hours early.
 */
const ISO_UTC = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?Z$/;

export function utcMillis(value, field = 'time') {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.getTime();
  const m = typeof value === 'string' ? ISO_UTC.exec(value) : null;
  if (m) {
    const ms = Date.parse(m[1] + '.' + (m[2] || '0').slice(0, 3).padEnd(3, '0') + 'Z');
    // Date.parse rolls 2026-02-30 over to March 2; a real instant prints back as itself.
    if (!Number.isNaN(ms) && new Date(ms).toISOString().slice(0, 19) === m[1]) return ms;
  }
  throw new Error(`Unreadable ${field} in an approval row: ${JSON.stringify(value)}`);
}
