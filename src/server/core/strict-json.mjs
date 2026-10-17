/**
 * Strict JSON parser for request bodies. JSON.parse is too forgiving for a security boundary:
 *  - duplicate keys silently keep the last value, so two stacks can disagree on what was sent
 *  - lone surrogates survive and are later mangled by databases
 *  - nesting is unbounded
 * Everything here is rejected with a BadJson error, which the HTTP layer turns into 400.
 */
export class BadJson extends Error {}

/** Integer literals must survive a round trip through an IEEE double; larger numbers belong in strings. */
const MAX_SAFE = Number.MAX_SAFE_INTEGER;

const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
export const MAX_DEPTH = 32;

export function parseStrictJson(text, { maxDepth = MAX_DEPTH } = {}) {
  let i = 0;
  const fail = (msg) => { throw new BadJson(msg + ' at position ' + i); };
  const ws = () => { while (i < text.length && ' \t\n\r'.includes(text[i])) i += 1; };

  function string() {
    const start = i;
    i += 1; // opening quote
    let out = '';
    for (;;) {
      if (i >= text.length) fail('Unterminated string');
      const ch = text[i];
      if (ch === '"') { i += 1; break; }
      if (ch < ' ') fail('Control character in string');
      if (ch === '\\') {
        const esc = text[i + 1];
        const map = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
        if (esc in map) { out += map[esc]; i += 2; continue; }
        if (esc === 'u') {
          const hex = text.slice(i + 2, i + 6);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail('Bad \\u escape');
          out += String.fromCharCode(parseInt(hex, 16));
          i += 6;
          continue;
        }
        fail('Bad escape');
      }
      out += ch;
      i += 1;
    }
    if (LONE_SURROGATE.test(out)) { i = start; fail('Invalid Unicode (unpaired surrogate)'); }
    return out;
  }

  // `depth` is the number of containers already open, so the body object is entered at depth 0 and is level 1.
  function value(depth) {
    ws();
    const ch = text[i];
    if ((ch === '{' || ch === '[') && depth + 1 > maxDepth) fail('Nested deeper than ' + maxDepth + ' levels');
    if (ch === '{') {
      i += 1;
      const obj = {};
      const seen = new Set();
      ws();
      if (text[i] === '}') { i += 1; return obj; }
      for (;;) {
        ws();
        if (text[i] !== '"') fail('Expected a string key');
        const key = string();
        if (seen.has(key)) fail('Duplicate key "' + key + '"');
        seen.add(key);
        ws();
        if (text[i] !== ':') fail('Expected ":"');
        i += 1;
        // defineProperty keeps "__proto__" an ordinary own property instead of changing the prototype
        Object.defineProperty(obj, key, { value: value(depth + 1), enumerable: true, writable: true, configurable: true });
        ws();
        if (text[i] === ',') { i += 1; continue; }
        if (text[i] === '}') { i += 1; return obj; }
        fail('Expected "," or "}"');
      }
    }
    if (ch === '[') {
      i += 1;
      const arr = [];
      ws();
      if (text[i] === ']') { i += 1; return arr; }
      for (;;) {
        arr.push(value(depth + 1));
        ws();
        if (text[i] === ',') { i += 1; continue; }
        if (text[i] === ']') { i += 1; return arr; }
        fail('Expected "," or "]"');
      }
    }
    if (ch === '"') return string();
    const literal = /^(true|false|null)/.exec(text.slice(i, i + 5));
    if (literal) { i += literal[1].length; return literal[1] === 'true' ? true : literal[1] === 'false' ? false : null; }
    const num = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/.exec(text.slice(i, i + 400));
    if (num) {
      const n = Number(num[0]);
      if (!Number.isFinite(n)) fail('Number out of range');
      if (num[2] === undefined && num[3] === undefined && Math.abs(n) > MAX_SAFE) {
        fail('Integers beyond ±' + MAX_SAFE + ' must be sent as strings');
      }
      i += num[0].length;
      return n === 0 ? 0 : n; // -0 is 0
    }
    return fail('Unexpected token');
  }

  const result = value(0);
  ws();
  if (i < text.length) fail('Unexpected content after the JSON value');
  return result;
}
