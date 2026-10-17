/**
 * WordPress Playground's dev server answers 500 to a malformed percent-escape (for example /%ff or /%zz) in its own HTTP
 * layer, before PHP runs, so three conformance checks cannot pass there. The same requests pass on PHP + SQLite and PHP + MySQL.
 * The match is deliberately narrow: any other failing check, or a 5xx on any other request, still fails the run.
 */
export function isPlaygroundLimit(result) {
  const detail = result.detail || '';
  if (result.id === 'edge.hostile-requests-never-5xx') {
    const offenders = detail.split(': ').slice(1).join(': ').split(' | ');
    return offenders.every((o) => /^GET \/%ff\S* +-> 500$/i.test(o.trim()));
  }
  if (result.id === 'doors.door-comes-first') {
    const offenders = detail.split('): ').slice(1).join('): ').split('; ');
    return offenders.length > 0 && offenders.every((o) => /^\w+ (GET|POST) \S*%zz\S* -> 500$/.test(o.trim()));
  }
  if (result.id === 'edge.path-rules') {
    return /^(malformed escape|lone percent sign|bytes that are not UTF-8): expected HTTP 400, got 500\b/.test(detail);
  }
  return false;
}
