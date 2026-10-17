/**
 * A JSON object kept as raw text per key and per value, so a mutation can produce text no serializer would ever write:
 * duplicate keys, a key spelled with escapes, a number like 01, a raw newline inside a string, nesting past the limit.
 *
 *   Obj = { entries: [{ key: '"action"', value: '"update:canonical"' | Obj }] }
 */
import { NUMBERS, LITERALS, STRINGS, CONTAINERS, KEYS } from './pools.mjs';

export const obj = (pairs) => ({ entries: pairs.map(([key, value]) => ({ key: JSON.stringify(key), value })) });

export function serialize(node, ws = null) {
  const gap = () => (ws ? ws() : '');
  if (typeof node === 'string') return node;
  return '{' + gap() + node.entries.map((e) => e.key + gap() + ':' + gap() + serialize(e.value, ws)).join(',' + gap()) + gap() + '}';
}

const VALID_WS = [' ', '\t', '\n', '\r', '  '];
const INVALID_WS = ['\f', '\v', ' ', ' ', ' ', '﻿', '\u0085', '​', '　'];

/** All entries of the object and of the objects inside it, with the object that holds each. */
function slots(node, out = []) {
  for (const e of node.entries) {
    out.push({ holder: node, entry: e });
    if (typeof e.value !== 'string') slots(e.value, out);
  }
  return out;
}

function anyValue(rng) {
  return rng.weighted([[3, () => rng.pick(NUMBERS)], [1, () => rng.pick(LITERALS)], [4, () => rng.pick(STRINGS)], [2, () => rng.pick(CONTAINERS)]])();
}

/**
 * Mutations. Each takes (rng, root) and returns { label, apply } where apply() edits the tree and may return a function
 * that post-processes the serialized bytes. They are separate from "pick which one" so a failing case can be shrunk by
 * dropping mutations one at a time.
 */
export const MUTATIONS = {
  setValue: (rng, root) => {
    const slot = rng.pick(slots(root));
    const value = anyValue(rng);
    return { label: `set ${slot.entry.key} = ${clip(value)}`, apply: () => { slot.entry.value = value; } };
  },
  dropKey: (rng, root) => {
    const slot = rng.pick(slots(root));
    return { label: `drop ${slot.entry.key}`, apply: () => remove(slot) };
  },
  dupKey: (rng, root) => {
    const slot = rng.pick(slots(root));
    const key = rng.chance(0.5) ? slot.entry.key : rng.pick(KEYS);
    const value = rng.chance(0.5) ? (typeof slot.entry.value === 'string' ? slot.entry.value : anyValue(rng)) : anyValue(rng);
    const after = rng.int(2); // decided now, never inside apply(): a mutation must behave the same when the others are removed while shrinking
    return { label: `duplicate ${key} = ${clip(value)}`, apply: () => { const at = slot.holder.entries.indexOf(slot.entry); slot.holder.entries.splice(at < 0 ? slot.holder.entries.length : at + after, 0, { key, value }); } };
  },
  addKey: (rng, root) => {
    const holder = rng.pick([root, ...slots(root).map((s) => s.entry.value).filter((v) => typeof v !== 'string')]);
    const key = rng.pick(KEYS);
    const value = anyValue(rng);
    return { label: `add ${clip(key)} = ${clip(value)}`, apply: () => { holder.entries.push({ key, value }); } };
  },
  renameKey: (rng, root) => {
    const slot = rng.pick(slots(root));
    const plain = slot.entry.key.slice(1, -1) || 'a';
    const variants = [plain.toUpperCase(), plain[0].toUpperCase() + plain.slice(1), plain + ' ', ' ' + plain, '\\u' + plain.charCodeAt(0).toString(16).padStart(4, '0') + plain.slice(1),
      plain.slice(0, 1) + '\\u0000' + plain.slice(1), plain.replace(/./, (c) => '\\u00' + c.charCodeAt(0).toString(16).toUpperCase())];
    const key = '"' + rng.pick(variants) + '"';
    return { label: `rename ${slot.entry.key} -> ${key}`, apply: () => { slot.entry.key = key; } };
  },
  shuffle: (rng, root) => {
    const holder = rng.pick([root, ...slots(root).map((s) => s.entry.value).filter((v) => typeof v !== 'string')]);
    const order = rng.shuffle(holder.entries);
    return { label: 'reorder keys', apply: () => { holder.entries = order; } };
  },
  whitespace: (rng) => {
    const invalid = rng.chance(0.4);
    const pool = invalid ? INVALID_WS : VALID_WS;
    const picks = Array.from({ length: 8 }, () => (rng.chance(0.5) ? '' : rng.pick(pool)));
    let i = 0;
    return { label: `${invalid ? 'invalid' : 'valid'} whitespace between tokens`, apply: () => ({ ws: () => picks[i++ % picks.length] }) };
  },
  bytesBefore: (rng) => {
    const junk = rng.pick(['﻿', ' ', '\n', '\u0000', 'x', ',', '//c\n', '/*c*/', '{}', '[', ' ', '﻿﻿', '​']);
    return { label: `bytes before: ${JSON.stringify(junk)}`, apply: () => ({ before: junk }) };
  },
  bytesAfter: (rng) => {
    const junk = rng.pick([' ', '\n', '\r\n', '\u0000', 'x', ',', '{}', '[]', '\n\n', '  ', '//c', '﻿', '}', ']', ' ']);
    return { label: `bytes after: ${JSON.stringify(junk)}`, apply: () => ({ after: junk }) };
  },
  truncate: (rng) => {
    const keep = rng.next();
    return { label: `truncate at ${(keep * 100).toFixed(0)}%`, apply: () => ({ post: (buf) => buf.subarray(0, Math.floor(buf.length * keep)) }) };
  },
  byteFlip: (rng) => {
    const at = rng.next();
    const byte = rng.pick([0x00, 0x08, 0x0a, 0x0c, 0x1f, 0x22, 0x5c, 0x7f, 0x80, 0xbf, 0xc0, 0xc1, 0xc3, 0xe2, 0xed, 0xf0, 0xf4, 0xf5, 0xfe, 0xff]);
    return { label: `replace the byte at ${(at * 100).toFixed(0)}% by 0x${byte.toString(16)}`, apply: () => ({ post: (buf) => { if (!buf.length) return buf; const out = Buffer.from(buf); out[Math.floor(at * out.length)] = byte; return out; } }) };
  },
  insertBytes: (rng) => {
    const at = rng.next();
    const bytes = rng.pick([[0xc0, 0xaf], [0xed, 0xa0, 0x80], [0xf4, 0x90, 0x80, 0x80], [0xe2, 0x82], [0xef, 0xbf, 0xbe], [0xef, 0xbf, 0xbf], [0xc2, 0x85], [0xe2, 0x80, 0xa8], [0x00], [0x0a], [0xf0, 0x9f, 0x99, 0x82]]);
    return { label: `insert ${bytes.map((b) => b.toString(16)).join(' ')} at ${(at * 100).toFixed(0)}%`, apply: () => ({ post: (buf) => { const i = Math.floor(at * buf.length); return Buffer.concat([buf.subarray(0, i), Buffer.from(bytes), buf.subarray(i)]); } }) };
  }
};

const WEIGHTS = [
  ['setValue', 10], ['dropKey', 3], ['dupKey', 4], ['addKey', 3], ['renameKey', 3], ['shuffle', 2], ['whitespace', 3],
  ['bytesBefore', 2], ['bytesAfter', 2], ['truncate', 1], ['byteFlip', 2], ['insertBytes', 2]
];

const NEEDS_A_KEY = new Set(['setValue', 'dropKey', 'dupKey', 'renameKey']);

export function chooseMutations(rng, root, count) {
  return Array.from({ length: count }, () => {
    const name = rng.weighted(WEIGHTS.map(([n, w]) => [w, n]));
    // An empty object has no key to change, drop or copy; adding one is the closest mutation.
    return MUTATIONS[NEEDS_A_KEY.has(name) && !root.entries.length ? 'addKey' : name](rng, root);
  });
}

/** Applies the mutations in order and returns the request body bytes plus a readable list of what was done. */
export function render(root, mutations) {
  const notes = [];
  let ws = null, before = '', after = '';
  const posts = [];
  for (const m of mutations) {
    const r = m.apply();
    notes.push(m.label);
    if (r) {
      if (r.ws) ws = r.ws;
      if (r.before !== undefined) before += r.before;
      if (r.after !== undefined) after += r.after;
      if (r.post) posts.push(r.post);
    }
  }
  let bytes = Buffer.from(before + serialize(root, ws) + after, 'utf8');
  for (const post of posts) bytes = post(bytes);
  return { bytes, notes };
}

function remove(slot) {
  const at = slot.holder.entries.indexOf(slot.entry);
  if (at >= 0) slot.holder.entries.splice(at, 1);
}

const clip = (s) => (s.length > 40 ? s.slice(0, 37) + '...' : s);
