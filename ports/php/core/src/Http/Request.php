<?php
declare(strict_types=1);

namespace Hermes\Approval\Http;

use Hermes\Approval\ApprovalException;

/** Request-parsing rules from docs/spec.md ("Strict input"), kept in one place so every PHP host behaves the same. */
final class Request
{
    /**
     * Percent-decodes one path segment exactly once. A malformed escape (%zz, a lone %) or bytes that are not UTF-8
     * after decoding are a 400. (rawurldecode alone would leave a malformed escape in place.)
     */
    public static function decodeSegment(string $segment): string
    {
        if (preg_match('/%(?![0-9A-Fa-f]{2})/', $segment) === 1) {
            throw ApprovalException::of('BAD_REQUEST', 'Malformed percent-encoding in the path.');
        }
        $decoded = rawurldecode($segment);
        if (!mb_check_encoding($decoded, 'UTF-8')) {
            throw ApprovalException::of('BAD_REQUEST', 'Path is not valid UTF-8 after percent-decoding.');
        }
        if (str_contains($decoded, "\0")) {
            throw ApprovalException::of('BAD_REQUEST', 'A path segment may not contain a NUL character.');
        }
        return $decoded;
    }

    /**
     * NUL (%00) is valid UTF-8, but some servers refuse it before the application runs (Kestrel, IIS, Apache), so the
     * contract says every stack answers 400 for a request path that contains it.
     */
    public static function assertNoNul(string $rawPath): void
    {
        if (str_contains($rawPath, '%00')) {
            throw ApprovalException::of('BAD_REQUEST', 'A path may not contain a NUL character.');
        }
    }

    /**
     * The request's Content-Type as the contract sees it: null when there was none. PHP-FPM, CGI and LiteSpeed hand PHP a
     * CONTENT_TYPE variable for every request, empty when the request had no Content-Type, so there an empty value can only mean
     * "none" (an empty header cannot be told from a missing one). php -S and Apache's mod_php keep the two apart, and there an
     * empty Content-Type is the type it says it is, which is not JSON.
     */
    public static function contentType(?string $value, string $sapi = PHP_SAPI): ?string
    {
        return $value === '' && in_array($sapi, ['fpm-fcgi', 'cgi-fcgi', 'cgi', 'litespeed'], true) ? null : $value;
    }

    /** The media type is application/json whatever its parameters or case ("application/json; charset=utf-8"). */
    public static function isJsonMediaType(string $contentType): bool
    {
        return strtolower(trim(explode(';', $contentType, 2)[0], " \t")) === 'application/json';
    }

    /**
     * Content-Type must be application/json, also for an empty body; no Content-Type is fine only for an empty body. Call it
     * once with the header alone (before reading the body) and once with the body. Without this rule a page on another site
     * could send a JSON body as a "simple" cross-origin request (text/plain), which a browser sends without asking first.
     */
    public static function assertJsonBody(?string $contentType, ?string $rawBody = null): void
    {
        $bad = $rawBody === null ? ($contentType !== null && !self::isJsonMediaType($contentType)) : ($contentType === null && $rawBody !== '');
        if ($bad) {
            throw ApprovalException::of('UNSUPPORTED_MEDIA_TYPE', 'Send the body as application/json.');
        }
    }

    /** A path segment that is a canonical integer is that number; anything else (007, +5, 4.0, abc) is a string. */
    public static function pathId(string $segment): int|string
    {
        return preg_match('/^(0|-?[1-9][0-9]{0,14})$/D', $segment) === 1 ? (int) $segment : $segment; // D: "$" must not match before a final newline
    }

    /** The first value of a query parameter, as every other stack reads it (PHP's own $_GET keeps the LAST one). */
    public static function firstQueryValue(string $queryString, string $name): ?string
    {
        foreach (explode('&', $queryString) as $pair) {
            if ($pair === '') {
                continue;
            }
            $kv = explode('=', $pair, 2);
            if (urldecode($kv[0]) === $name) {
                return urldecode($kv[1] ?? '');
            }
        }
        return null;
    }

    /** siteId: absent = 1, otherwise a positive integer of at most nine digits. */
    public static function siteId(string $queryString): int
    {
        $raw = self::firstQueryValue($queryString, 'siteId');
        if ($raw === null) {
            return 1;
        }
        if (preg_match('/^[1-9][0-9]{0,8}$/D', $raw) !== 1) {
            throw ApprovalException::of('BAD_REQUEST', 'siteId must be a positive integer.');
        }
        return (int) $raw;
    }

    /** The list filter: absent or empty = pending; ASCII letters only are case-folded (so İ is not an i). */
    public static function status(string $queryString): string
    {
        $raw = self::firstQueryValue($queryString, 'status');
        return $raw === null || $raw === '' ? 'pending' : strtr($raw, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz');
    }
}
