<?php
declare(strict_types=1);

namespace Hermes\Approval;

/** UTC instants as ISO-8601 strings ("2026-10-14T21:25:31.123Z"). */
final class Time
{
    public static function iso(float $unixSeconds): string
    {
        // Whole milliseconds first: (x - floor(x)) * 1000 turns .123 into 122.99999 and loses a millisecond.
        $ms = (int) round($unixSeconds * 1000);
        $whole = intdiv($ms, 1000);
        $fraction = $ms - $whole * 1000;
        if ($fraction < 0) {
            $whole -= 1;
            $fraction += 1000;
        }
        return gmdate('Y-m-d\TH:i:s', $whole) . sprintf('.%03dZ', $fraction);
    }

    /**
     * Fraction optional, "Z" required. Anything else is a store bug and throws: returning 0 for an unreadable value
     * made every row "expired" on SQLite, which keeps whole seconds only.
     */
    public static function parse(string $iso): float
    {
        if (preg_match('/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?Z$/D', $iso, $m) === 1) {
            $dt = \DateTimeImmutable::createFromFormat('!Y-m-d\TH:i:s', $m[1], new \DateTimeZone('UTC'));
            // createFromFormat rolls 2026-02-30 over to March; a real instant prints back as itself.
            if ($dt !== false && $dt->format('Y-m-d\TH:i:s') === $m[1]) {
                return (float) $dt->getTimestamp() + (isset($m[2]) ? (float) ('0.' . $m[2]) : 0.0);
            }
        }
        throw new \UnexpectedValueException('Unreadable time in an approval row: ' . $iso);
    }
}
