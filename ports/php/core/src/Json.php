<?php
declare(strict_types=1);

namespace Hermes\Approval;

/**
 * Strict JSON for a security boundary (docs/spec.md "Strict input"). PHP's json_decode is too forgiving:
 * duplicate keys silently keep the last value, "1.0" becomes a float, big integers lose precision, and
 * PHP arrays cannot tell {} from []. This parser refuses what two stacks could read differently:
 * duplicate keys, invalid UTF-8, unpaired surrogates, nesting deeper than 32 containers, non-finite numbers.
 * Objects become JObject; arrays become lists; integers that fit 64 bits stay int, other numbers are float.
 */
final class Json
{
    public const MAX_DEPTH = 32;
    public const MAX_SAFE_INTEGER = 9007199254740991;

    // JavaScript's String.prototype.trim() set, so "the same string" is trimmed the same way on every stack.
    private const TRIM = '[\x{9}-\x{D}\x{20}\x{A0}\x{1680}\x{2000}-\x{200A}\x{2028}\x{2029}\x{202F}\x{205F}\x{3000}\x{FEFF}]';

    private string $text;
    private int $i = 0;
    private bool $strict;

    private function __construct(string $text, bool $strict)
    {
        $this->text = $text;
        $this->strict = $strict;
    }

    /**
     * Parses a request body. Strict: the rules in docs/spec.md "Strict input".
     * @throws ApprovalException BAD_REQUEST
     */
    public static function parse(string $text): mixed
    {
        return self::run($text, true);
    }

    /**
     * Parses JSON this system wrote itself (database columns). It must never refuse a row because the input rules were
     * tightened after the row was stored, so the limits on number size and nesting do not apply.
     */
    public static function parseStored(string $text): mixed
    {
        return self::run($text, false);
    }

    private static function run(string $text, bool $strict): mixed
    {
        if (!mb_check_encoding($text, 'UTF-8')) {
            throw ApprovalException::of('BAD_REQUEST', 'Body is not valid UTF-8.');
        }
        $p = new self($text, $strict);
        $value = $p->value(0);
        $p->ws();
        if ($p->i < strlen($text)) {
            $p->fail('Unexpected content after the JSON value');
        }
        return $value;
    }

    private function fail(string $message): never
    {
        throw ApprovalException::of('BAD_REQUEST', 'Body is not acceptable JSON: ' . $message . ' at position ' . $this->i);
    }

    private function ws(): void
    {
        $n = strlen($this->text);
        while ($this->i < $n && ($c = $this->text[$this->i]) !== '' && ($c === ' ' || $c === "\t" || $c === "\n" || $c === "\r")) {
            $this->i++;
        }
    }

    private function value(int $depth): mixed
    {
        $this->ws();
        $c = $this->text[$this->i] ?? '';
        if ($c === '{') {
            if ($this->strict && $depth + 1 > self::MAX_DEPTH) {
                $this->fail('Nested deeper than ' . self::MAX_DEPTH . ' levels');
            }
            return $this->object($depth);
        }
        if ($c === '[') {
            if ($this->strict && $depth + 1 > self::MAX_DEPTH) {
                $this->fail('Nested deeper than ' . self::MAX_DEPTH . ' levels');
            }
            return $this->arrayValue($depth);
        }
        if ($c === '"') {
            return $this->string();
        }
        foreach (['true' => true, 'false' => false, 'null' => null] as $word => $value) {
            if (substr_compare($this->text, $word, $this->i, strlen($word)) === 0) {
                $this->i += strlen($word);
                return $value;
            }
        }
        if (preg_match('/\G-?(?:0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?/', $this->text, $m, 0, $this->i) === 1) {
            $this->i += strlen($m[0]);
            return $this->number($m[0], isset($m[1]) && $m[1] !== '' || isset($m[2]) && $m[2] !== '');
        }
        $this->fail('Unexpected token');
    }

    private function number(string $literal, bool $isFloat): int|float
    {
        if (!$isFloat) {
            // Integer literals must survive a round trip through an IEEE double (what the other stacks use).
            if ($literal === '-0') {
                return 0;
            }
            $asInt = (int) $literal;
            if ((string) $asInt !== $literal) {
                return $this->strict ? $this->fail('Integers beyond ±' . self::MAX_SAFE_INTEGER . ' must be sent as strings') : (float) $literal;
            }
            if ($this->strict && abs($asInt) > self::MAX_SAFE_INTEGER) {
                $this->fail('Integers beyond ±' . self::MAX_SAFE_INTEGER . ' must be sent as strings');
            }
            return $asInt;
        }
        $f = (float) $literal;
        if (!is_finite($f)) {
            $this->fail('Number out of range');
        }
        return $f;
    }

    private function object(int $depth): JObject
    {
        $this->i++;
        $obj = new JObject();
        $this->ws();
        if (($this->text[$this->i] ?? '') === '}') {
            $this->i++;
            return $obj;
        }
        while (true) {
            $this->ws();
            if (($this->text[$this->i] ?? '') !== '"') {
                $this->fail('Expected a string key');
            }
            $key = $this->string();
            if ($obj->has($key)) {
                $this->fail('Duplicate key');
            }
            $this->ws();
            if (($this->text[$this->i] ?? '') !== ':') {
                $this->fail('Expected ":"');
            }
            $this->i++;
            $obj->set($key, $this->value($depth + 1));
            $this->ws();
            $c = $this->text[$this->i] ?? '';
            if ($c === ',') {
                $this->i++;
                continue;
            }
            if ($c === '}') {
                $this->i++;
                return $obj;
            }
            $this->fail('Expected "," or "}"');
        }
    }

    /** @return list<mixed> */
    private function arrayValue(int $depth): array
    {
        $this->i++;
        $list = [];
        $this->ws();
        if (($this->text[$this->i] ?? '') === ']') {
            $this->i++;
            return $list;
        }
        while (true) {
            $list[] = $this->value($depth + 1);
            $this->ws();
            $c = $this->text[$this->i] ?? '';
            if ($c === ',') {
                $this->i++;
                continue;
            }
            if ($c === ']') {
                $this->i++;
                return $list;
            }
            $this->fail('Expected "," or "]"');
        }
    }

    private function string(): string
    {
        $start = $this->i;
        $this->i++;
        $out = '';
        $n = strlen($this->text);
        while (true) {
            if ($this->i >= $n) {
                $this->fail('Unterminated string');
            }
            if (preg_match('/\G[^"\\\\\x00-\x1f]+/', $this->text, $m, 0, $this->i) === 1) {
                $out .= $m[0];
                $this->i += strlen($m[0]);
                continue;
            }
            $c = $this->text[$this->i];
            if ($c === '"') {
                $this->i++;
                return $out;
            }
            if ($c !== '\\') {
                $this->fail('Control character in string');
            }
            $e = $this->text[$this->i + 1] ?? '';
            $map = ['"' => '"', '\\' => '\\', '/' => '/', 'b' => "\x08", 'f' => "\x0c", 'n' => "\n", 'r' => "\r", 't' => "\t"];
            if ($e !== '' && isset($map[$e])) {
                $out .= $map[$e];
                $this->i += 2;
                continue;
            }
            if ($e !== 'u') {
                $this->fail('Bad escape');
            }
            $unit = $this->hex4($this->i + 2);
            $this->i += 6;
            if ($unit >= 0xD800 && $unit <= 0xDBFF) {
                if (($this->text[$this->i] ?? '') !== '\\' || ($this->text[$this->i + 1] ?? '') !== 'u') {
                    $this->i = $start;
                    $this->fail('Invalid Unicode (unpaired surrogate)');
                }
                $low = $this->hex4($this->i + 2);
                if ($low < 0xDC00 || $low > 0xDFFF) {
                    $this->i = $start;
                    $this->fail('Invalid Unicode (unpaired surrogate)');
                }
                $this->i += 6;
                $out .= mb_chr(0x10000 + (($unit - 0xD800) << 10) + ($low - 0xDC00), 'UTF-8');
            } elseif ($unit >= 0xDC00 && $unit <= 0xDFFF) {
                $this->i = $start;
                $this->fail('Invalid Unicode (unpaired surrogate)');
            } else {
                $out .= mb_chr($unit, 'UTF-8');
            }
        }
    }

    private function hex4(int $at): int
    {
        $hex = substr($this->text, $at, 4);
        if (strlen($hex) !== 4 || !ctype_xdigit($hex)) {
            $this->fail('Bad \\u escape');
        }
        return (int) hexdec($hex);
    }

    // ------------------------------------------------------------------ writing

    /** Compact JSON the way JSON.stringify writes it (raw UTF-8, only quotes, backslashes and control characters escaped). */
    public static function encode(mixed $value): string
    {
        if ($value === null) {
            return 'null';
        }
        if (is_bool($value)) {
            return $value ? 'true' : 'false';
        }
        if (is_int($value)) {
            return (string) $value;
        }
        if (is_float($value)) {
            return self::numberText($value);
        }
        if (is_string($value)) {
            return self::quote($value);
        }
        if ($value instanceof JObject) {
            $parts = [];
            foreach ($value->pairs() as $k => $v) {
                $parts[] = self::quote($k) . ':' . self::encode($v);
            }
            return '{' . implode(',', $parts) . '}';
        }
        if (is_array($value)) {
            if (array_is_list($value)) {
                return '[' . implode(',', array_map([self::class, 'encode'], $value)) . ']';
            }
            $parts = [];
            foreach ($value as $k => $v) {
                $parts[] = self::quote((string) $k) . ':' . self::encode($v);
            }
            return '{' . implode(',', $parts) . '}';
        }
        throw new \InvalidArgumentException('Cannot encode ' . get_debug_type($value));
    }

    private static function quote(string $s): string
    {
        return '"' . preg_replace_callback('/["\\\\\x00-\x1f]/', static function (array $m): string {
            return match ($m[0]) {
                '"' => '\\"', '\\' => '\\\\', "\x08" => '\\b', "\x0c" => '\\f', "\n" => '\\n', "\r" => '\\r', "\t" => '\\t',
                default => sprintf('\\u%04x', ord($m[0])),
            };
        }, $s) . '"';
    }

    /** Number text as JavaScript prints it, so lengths and comparisons agree with the other stacks. */
    public static function numberText(float $f): string
    {
        if ($f === 0.0) {
            return '0';
        }
        $sign = $f < 0 ? '-' : '';
        $f = abs($f);
        // Shortest digits that round-trip.
        $repr = '';
        for ($p = 0; $p <= 16; $p++) {
            $repr = sprintf('%.' . $p . 'e', $f);
            if ((float) $repr === $f) {
                break;
            }
        }
        [$mantissa, $exp] = explode('e', $repr);
        $digits = rtrim(str_replace('.', '', $mantissa), '0');
        $digits = $digits === '' ? '0' : $digits;
        $k = strlen($digits);
        $n = (int) $exp + 1;
        if ($k <= $n && $n <= 21) {
            $text = $digits . str_repeat('0', $n - $k);
        } elseif (0 < $n && $n <= 21) {
            $text = substr($digits, 0, $n) . '.' . substr($digits, $n);
        } elseif (-6 < $n && $n <= 0) {
            $text = '0.' . str_repeat('0', -$n) . $digits;
        } else {
            $e = $n - 1;
            $text = ($k === 1 ? $digits : $digits[0] . '.' . substr($digits, 1)) . 'e' . ($e < 0 ? '-' : '+') . abs($e);
        }
        return $sign . $text;
    }

    /** Length in UTF-16 code units of the compact JSON text: what the "16384 characters" limit counts. */
    public static function compactLength(mixed $value): int
    {
        return self::utf16Length(self::encode($value));
    }

    public static function utf16Length(string $s): int
    {
        return mb_strlen($s, 'UTF-8') + (int) preg_match_all('/[\x{10000}-\x{10FFFF}]/u', $s);
    }

    public static function trim(string $s): string
    {
        return (string) preg_replace('/^' . self::TRIM . '+|' . self::TRIM . '+$/u', '', $s);
    }

    /** Stable form for comparisons: keys sorted at every depth, 1 / 1.0 / 1e0 identical, 42 and "42" different. */
    public static function canonical(mixed $value): string
    {
        if ($value instanceof JObject) {
            $keys = $value->keys();
            sort($keys, SORT_STRING);
            $parts = [];
            foreach ($keys as $k) {
                $parts[] = self::quote($k) . ':' . self::canonical($value->get($k));
            }
            return '{' . implode(',', $parts) . '}';
        }
        if (is_array($value)) {
            return '[' . implode(',', array_map([self::class, 'canonical'], $value)) . ']';
        }
        if (is_float($value) && $value === floor($value) && abs($value) < 9.2e18) {
            return (string) (int) $value;
        }
        return self::encode($value);
    }
}
