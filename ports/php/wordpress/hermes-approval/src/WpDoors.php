<?php
declare(strict_types=1);

namespace Hermes\Approval\Wp;

/**
 * Who is calling. Agent: static API keys from wp-config.php. Reviewer: a signed-in WordPress user who has the capability
 * (REST cookie requests need the X-WP-Nonce, which is the CSRF protection; Application Passwords work for scripts).
 */
final class WpDoors
{
    /** @return array{read:bool,write:bool} */
    public function agent(\WP_REST_Request $request): array
    {
        $given = self::apiKeyHeader($request);
        if ($given === '') {
            return ['read' => false, 'write' => false];
        }
        $write = self::matches($given, self::keys('HERMES_APPROVAL_WRITE_KEYS'));
        return ['write' => $write, 'read' => $write || self::matches($given, self::keys('HERMES_APPROVAL_READ_KEYS'))];
    }

    /**
     * The value of the X-Api-Key header. PHP files "X-Api-Key" and "X_Api_Key" under the same name, so a header spelled with
     * underscores (which a proxy rule about X-Api-Key would never see) must not count: read the names as they were sent.
     * Spaces and tabs around a value are not part of it (RFC 9110); Apache and nginx strip them, PHP's built-in server keeps a tab.
     */
    private static function apiKeyHeader(\WP_REST_Request $request): string
    {
        if (!function_exists('getallheaders')) {
            return trim((string) $request->get_header('x_api_key'), " \t");
        }
        $values = [];
        foreach (getallheaders() as $name => $value) {
            if (strcasecmp((string) $name, 'X-Api-Key') === 0) {
                $values[] = (string) $value;
            }
        }
        return trim(implode(', ', $values), " \t");
    }

    /** @return array{id:string}|null */
    public function reviewer(): ?array
    {
        if (!is_user_logged_in()) {
            return null;
        }
        $cap = defined('HERMES_APPROVAL_REVIEW_CAP') ? (string) HERMES_APPROVAL_REVIEW_CAP : 'edit_others_posts';
        $user = wp_get_current_user();
        return user_can($user, $cap) ? ['id' => $user->user_login] : null;
    }

    /** @return list<string> */
    private static function keys(string $constant): array
    {
        if (!defined($constant)) {
            return [];
        }
        $value = constant($constant);
        $list = is_array($value) ? $value : explode(',', (string) $value);
        return array_values(array_filter(array_map('trim', $list), static fn ($k) => $k !== ''));
    }

    /** @param list<string> $keys */
    private static function matches(string $given, array $keys): bool
    {
        foreach ($keys as $key) {
            if (hash_equals($key, $given)) {
                return true;
            }
        }
        return false;
    }
}
