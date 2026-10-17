<?php
declare(strict_types=1);

namespace Hermes\Approval\Wp;

use Hermes\Approval\ApprovalService;
use Hermes\Approval\Profile;

require_once __DIR__ . '/WpdbStore.php';
require_once __DIR__ . '/WpCmsAdapter.php';
require_once __DIR__ . '/WpDoors.php';
require_once __DIR__ . '/WpNotifier.php';
require_once __DIR__ . '/RawJson.php';
require_once __DIR__ . '/RestApi.php';
require_once __DIR__ . '/AdminPage.php';
require_once __DIR__ . '/Frontend.php';

/** Wires the core to WordPress: tables, REST routes, the response writer, the review page and the front-end output. */
final class Plugin
{
    public const NAMESPACE = 'hermes-approval/v1';
    public const DB_VERSION = '1';

    public static function boot(): void
    {
        add_action('rest_api_init', [self::class, 'registerRoutes']);
        // After WordPress's own CORS filter (priority 10), so ours can take its headers back off.
        add_filter('rest_pre_serve_request', [RestApi::class, 'serve'], 20, 4);
        add_filter('rest_request_before_callbacks', [self::class, 'ownJsonErrors'], 10, 3);
        add_filter('rest_endpoints', [self::class, 'ownNamespaceRoot']);
        add_action('plugins_loaded', [self::class, 'maybeInstall']);
        add_action('hermes_approval_rolled_back', [WpCmsAdapter::class, 'forget']);
        AdminPage::boot();
        Frontend::boot();
    }

    public static function activate(): void
    {
        WpdbStore::install();
        update_option('hermes_approval_db_version', self::DB_VERSION);
    }

    public static function maybeInstall(): void
    {
        if (get_option('hermes_approval_db_version') !== self::DB_VERSION) {
            self::activate();
        }
    }

    public static function service(): ApprovalService
    {
        static $service = null;
        return $service ??= ApprovalService::create(new WpdbStore(), new WpCmsAdapter(), self::profile(), 86400, WpNotifier::fromConstants());
    }

    public static function profile(): Profile
    {
        return new Profile(WpCmsAdapter::actions(), ['seo:write', 'content:update', 'schema:manage']);
    }

    /**
     * WordPress parses JSON bodies itself and answers bad JSON with its own error shape before any plugin code runs.
     * For our routes, drop that verdict: the core parses the raw body strictly and answers in the spec's envelope.
     */
    public static function ownJsonErrors(mixed $response, array $handler, \WP_REST_Request $request): mixed
    {
        if (is_wp_error($response) && $response->get_error_code() === 'rest_invalid_json' && self::isOurs($request)) {
            return null;
        }
        return $response;
    }

    /**
     * WordPress answers the bare namespace URL (/wp-json/hermes-approval/v1, with or without a trailing slash) with its own
     * route index. Hand that URL to the same catch-all, so it is a 404 in the spec's envelope like every other unknown path.
     */
    public static function ownNamespaceRoot(array $endpoints): array
    {
        $catchAll = '/' . self::NAMESPACE . '/(?P<path>.*)';
        if (isset($endpoints[$catchAll])) {
            $endpoints['/' . self::NAMESPACE] = $endpoints[$catchAll];
        }
        return $endpoints;
    }

    public static function isOurs(\WP_REST_Request $request): bool
    {
        $route = $request->get_route();
        return $route === '/' . self::NAMESPACE || str_starts_with($route, '/' . self::NAMESPACE . '/');
    }

    public static function registerRoutes(): void
    {
        // One catch-all route: the core owns routing and the error envelope, WordPress only supplies identity and transport.
        register_rest_route(self::NAMESPACE, '/(?P<path>.*)', [
            'methods' => \WP_REST_Server::ALLMETHODS,
            'callback' => static fn (\WP_REST_Request $r) => RestApi::handle($r, self::service(), new WpDoors()),
            'permission_callback' => '__return_true',
        ]);
    }
}
