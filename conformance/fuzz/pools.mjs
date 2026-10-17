/**
 * The awkward values the fuzzer draws from. Everything is RAW JSON TEXT (or raw path text), so a pool entry can be invalid
 * JSON on purpose and nothing is normalized by a serializer on the way out.
 */
const rep = (s, n) => s.repeat(n);

export const NUMBERS = [
  '0', '-0', '1', '-1', '2', '42', '1.0', '1.5', '1e0', '1E0', '1e+0', '10e-1', '0.1', '0.30000000000000004', '1e21', '1e-7', '1.7976931348623157e308',
  '5e-324', '123456789012345678', '9007199254740991', '9007199254740992', '9007199254740993', '-9007199254740991', '-9007199254740993',
  '12345678901234567890', '1e999', '-1e999', '1e-999', '00', '01', '-01', '+1', '.5', '5.', '1.e3', '0x10', 'NaN', 'Infinity', '-Infinity', '-', '1e', '1e+', '1_000',
  '1.0000000000000000000001', '4.9e-324', '2147483647', '2147483648', '4294967296', '9223372036854775807', '9223372036854775808'
];

export const LITERALS = ['null', 'true', 'false', 'True', 'NULL', 'nul', 'tru', 'undefined'];

export const STRINGS = [
  '""', '" "', '"a"', '"A"', '"42"', '"1"', '"0"', '"-1"', '"1.0"', '"1e3"', '"abc"', '"update:canonical"', '"seo:write"', '"UPDATE:CANONICAL"', '" update:canonical"',
  '"update:canonical "', '"update:canonical\\n"', '"seo:write\\u0000"', '"\\u0000"', '"a\\u0000b"', '"\\ud800"', '"\\udc00"', '"\\ud800\\udc00"', '"\\ud83d\\ude00"', '"\\ud83d"',
  '"\\ude00\\ud83d"', '"\\ud800\\u0041"', '"é"', '"\\u00e9"', '"\\u00E9"', '"e\\u0301"', '"\\u212b"', '"\\u2028"', '"\\u2029"', '"\\u0085"', '"\\u00a0"', '"\\ufeff"', '"\\u200b"',
  '"\\u202e"', '"\\u0007"', '"\\u001f"', '"\\u007f"', '"\\/"', '"\\\\"', '"\\""', '"\\x41"', '"\\u12"', '"\\uZZZZ"', '"\\q"', '"\\"', '"a\nb"', '"a\tb"', '"a\u0000b"',
  '"ب"', '"🙂"', '"مرحبا"', '"https://example.com/x"', '"https://example.com/x y"', '"javascript:alert(1)"', '"__proto__"', '"constructor"',
  JSON.stringify(rep('a', 1023)), JSON.stringify(rep('a', 1024)), JSON.stringify(rep('a', 1025)), JSON.stringify(rep('ب', 1024)), JSON.stringify(rep('🙂', 512)), JSON.stringify(rep('🙂', 513)),
  JSON.stringify(rep('a', 99)), JSON.stringify(rep('a', 100)), JSON.stringify(rep('a', 101)), JSON.stringify(rep('a', 199)), JSON.stringify(rep('a', 200)), JSON.stringify(rep('a', 201)),
  JSON.stringify(rep('a', 16000)), JSON.stringify(rep('a', 20000))
];

export const CONTAINERS = [
  '{}', '[]', '{"a":1}', '[1,2]', '[[]]', '[{}]', '{"a":{"a":{"a":{}}}}', '[,]', '[1,]', '{,}', '{"a":1,}', '{"a" 1}', "{'a':1}", '{a:1}', '[1 2]', '{"a":1 "b":2}',
  '{"a":1,"a":2}', '{"a":1,"A":2}', '{"__proto__":{"x":1}}', '{"constructor":{"prototype":{}}}', '{"":""}', '{"0":0,"00":1}', '{"-0":1,"0":2}',
  '[' + rep('[', 29) + rep(']', 29) + ']', rep('[', 30) + rep(']', 30), rep('[', 31) + rep(']', 31), rep('[', 32) + rep(']', 32), rep('[', 33) + rep(']', 33), rep('[', 200) + rep(']', 200),
  rep('{"a":', 30) + '1' + rep('}', 30), rep('{"a":', 33) + '1' + rep('}', 33)
];

export const KEYS = [
  '"__proto__"', '"constructor"', '"toString"', '"hasOwnProperty"', '"prototype"', '""', '"0"', '"00"', '"-0"', '"1e3"', '"01"', '"\\u0000"', '"a\\u0000"', '"\\u0061ction"', '"ACTION"',
  '"Action"', '"action "', '" action"', '"éa"', '"e\\u0301a"', '"\\ud800"', '"🙂"', '"ب"', '"a.b"', '"a[0]"', '"a b"', '"$ne"', '"__proto__.x"', '"\\n"', '"\\t"', JSON.stringify(rep('k', 500)), JSON.stringify(rep('k', 10000))
];

/** Raw path-segment text (already percent-encoded where it matters). */
export const SEGMENT_TOKENS = [
  '0', '1', '2', '42', '007', '-1', '-0', '+5', '%2B5', '1e3', '4.0', '4.', '.4', '0x2a', '99999999999999999999', '9007199254740993', '9223372036854775807', '9223372036854775808',
  '%0A', '%0D', '%0D%0A', '%20', '%09', '%0B', '%0C', '%00', '%1F', '%7F', '%C2%A0', '%C2%85', '%E2%80%A8', '%EF%BB%BF', '%E2%80%8B', '%EF%BC%91', '%D9%A1', '%DB%B1',
  '%2F', '%2f', '%5C', '%5c', '%2E', '%2e', '%2e%2e', '..', '.', ';', ';x=1', ',', '%3B', '%3F', '%23', '%25', '%2525', '%252F', '%', '%%', '%4', '%zz', '%ZZ', '%G0', '%-1', '%u0041',
  '%ff', '%FF', '%c0%af', '%C0%AF', '%ed%a0%80', '%ED%A0%80', '%f4%90%80%80', '%F4%90%80%80', '%e2%82', '%E2%82', '%e2%82%ac', '%80', '%C3', '%C3%28', '%F0%9F%99%82', '%f0%9f%99',
  '%41', '%61', '%7e', '%7E', '~', '!', '*', "'", '(', ')', '@', ':', '=', '&', '$', '+', 'a', 'A', '%C3%A9', 'e%CC%81', '%EF%BC%8F', '%E2%88%95',
  'null', 'true', 'undefined', 'NaN', '__proto__', 'constructor', 'toString', 'a'.repeat(300), '9'.repeat(400), '%41'.repeat(100)
];

/** Query-string fragments for siteId / status and unrelated parameters. */
export const QUERY_VALUES = [
  '', '0', '1', '2', '01', '-1', '+1', '%2B1', '1.0', '1e0', '%201', '1%20', '1%0A', '%0A1', '1%00', '%EF%BC%91', '9', '999999999', '1000000000', '9999999999', 'abc', 'true', 'null',
  '1&siteId=2', '%31', '%3', '%zz', '%', '1%2', 'pending', 'history', 'PENDING', 'History', 'bogus', 'pend%C4%B0ng', 'PEND%C4%B0NG', 'pending%20', '%20pending', 'pending%0A',
  'pending,history', 'pending;history', 'all', '*', 'x'.repeat(5000)
];
export const QUERY_NAMES = ['siteId', 'siteid', 'SITEID', 'siteId[]', 'siteId[0]', 'site%49d', 'siteI%64', 'status', 'STATUS', 'status[]', 'sta%74us', 'status%20', '%20status', 'x', '', '%00', '%zz'];
