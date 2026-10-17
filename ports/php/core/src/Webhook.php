<?php
declare(strict_types=1);

namespace Hermes\Approval;

/**
 * What a decision notification looks like on the wire (docs/spec.md, "Decision notifications"), so every notifier
 * builds the same bytes. Sending them is the notifier's job: it knows the HTTP client of its framework.
 */
final class Webhook
{
    public const TIMEOUT_SECONDS = 3;

    /** The one body a notification has: compact JSON, this key order, no content. */
    public static function body(Row $row): string
    {
        return Json::encode(['event' => 'decision', 'approvalId' => $row->approvalId, 'status' => $row->status, 'decidedUtc' => $row->decidedUtc]);
    }

    /** "sha256=" and the lowercase hex HMAC-SHA256 of "<unix seconds>.<raw body>". */
    public static function sign(string $secret, string $timestamp, string $body): string
    {
        return 'sha256=' . hash_hmac('sha256', $timestamp . '.' . $body, $secret);
    }

    /**
     * Request headers for one delivery. Without a secret there is no proof of origin, so no timestamp or signature.
     * @return array<string,string>
     */
    public static function headers(string $secret, string $body, ?int $now = null): array
    {
        $headers = ['Content-Type' => 'application/json', 'X-Hermes-Delivery' => bin2hex(random_bytes(16))];
        if ($secret !== '') {
            $timestamp = (string) ($now ?? time());
            $headers['X-Hermes-Timestamp'] = $timestamp;
            $headers['X-Hermes-Signature'] = self::sign($secret, $timestamp, $body);
        }
        return $headers;
    }

    /** The receiver is where the operator said: http or https, and no user name or password in the URL. */
    public static function isValidUrl(string $url): bool
    {
        $parts = parse_url($url);
        if ($parts === false || !isset($parts['scheme'], $parts['host'])) {
            return false;
        }
        return in_array(strtolower($parts['scheme']), ['http', 'https'], true) && !isset($parts['user']) && !isset($parts['pass']);
    }
}
