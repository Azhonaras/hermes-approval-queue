/**
 * Stable JSON serialization: object keys sorted at every depth.
 * Two payloads are "the same" for the guard when their canonical strings match.
 */
export function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  return '{' + Object.keys(value).sort()
    .filter((k) => value[k] !== undefined)
    .map((k) => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
}

export function sameJson(a, b) {
  return canonical(a) === canonical(b);
}
