<?php
declare(strict_types=1);

namespace Hermes\Approval;

/**
 * A JSON object. PHP arrays cannot be used: they turn the key "0" into the integer 0, cannot tell {} from [],
 * and stdClass refuses keys that start with a NUL byte. Keys are stored with a prefix to dodge all three.
 */
final class JObject implements \Countable
{
    /** @var array<string, mixed> */
    private array $items = [];

    /** @param array<string, mixed> $pairs */
    public static function from(array $pairs): self
    {
        $o = new self();
        foreach ($pairs as $k => $v) {
            $o->set((string) $k, $v);
        }
        return $o;
    }

    public function set(string $key, mixed $value): void
    {
        $this->items['k' . $key] = $value;
    }

    public function has(string $key): bool
    {
        return array_key_exists('k' . $key, $this->items);
    }

    public function get(string $key): mixed
    {
        return $this->items['k' . $key] ?? null;
    }

    /** @return list<string> */
    public function keys(): array
    {
        return array_map(static fn ($k) => substr((string) $k, 1), array_keys($this->items));
    }

    public function count(): int
    {
        return count($this->items);
    }

    /** @return \Generator<string, mixed> */
    public function pairs(): \Generator
    {
        foreach ($this->items as $k => $v) {
            yield substr((string) $k, 1) => $v;
        }
    }
}
