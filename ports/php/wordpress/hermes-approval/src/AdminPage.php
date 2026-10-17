<?php
declare(strict_types=1);

namespace Hermes\Approval\Wp;

/**
 * The review page inside wp-admin: "Agent requests" in the admin menu, with a count of what is waiting.
 *
 * It is the same review UI as the demo (ui/, copied in by build.mjs), shown in a frame and signed in as the current
 * WordPress user: the login cookie plus the REST nonce, which is WordPress's own CSRF protection. The agent's keys are
 * never on this page, and only users with the review capability can open it.
 */
final class AdminPage
{
    public const SLUG = 'hermes-approval';

    public static function boot(): void
    {
        add_action('admin_menu', [self::class, 'menu']);
        add_action('admin_init', [self::class, 'frame']); // before wp-admin prints anything
    }

    public static function capability(): string
    {
        return defined('HERMES_APPROVAL_REVIEW_CAP') ? (string) HERMES_APPROVAL_REVIEW_CAP : 'edit_others_posts';
    }

    public static function menu(): void
    {
        $count = current_user_can(self::capability()) ? WpdbStore::countPending() : 0;
        $bubble = $count > 0
            ? ' <span class="awaiting-mod count-' . $count . '"><span class="pending-count">' . number_format_i18n($count) . '</span></span>'
            : '';
        add_menu_page('Agent requests', 'Agent requests' . $bubble, self::capability(), self::SLUG, [self::class, 'render'], 'dashicons-shield', 26);
    }

    public static function render(): void
    {
        $src = add_query_arg(['page' => self::SLUG, 'frame' => '1'], admin_url('admin.php'));
        echo '<div class="wrap" style="margin:0 0 0 -20px"><h1 class="screen-reader-text">Agent requests</h1>'
            . '<iframe id="hermes-approval-frame" title="Agent requests" src="' . esc_url($src) . '"'
            . ' style="display:block;width:100%;height:calc(100vh - 32px);min-height:560px;border:0;background:#f5f5f3"></iframe></div>';
    }

    /** admin.php?page=hermes-approval&frame=1 is the bare review document the frame shows (also usable on its own). */
    public static function frame(): void
    {
        if (($_GET['page'] ?? '') !== self::SLUG || ($_GET['frame'] ?? '') !== '1') {
            return;
        }
        if (!current_user_can(self::capability())) {
            wp_die(esc_html__('Sorry, you are not allowed to access this page.'), 403);
        }
        $file = self::uiDir() . 'index.html';
        if (!is_file($file)) {
            wp_die('The review page is not in this copy of the plugin. Build it with: node ports/php/wordpress/build.mjs', 500);
        }
        $config = [
            'apiBase' => rest_url(Plugin::NAMESPACE),
            'headers' => ['X-WP-Nonce' => wp_create_nonce('wp_rest')],
            'cmsHome' => admin_url(),
        ];
        $head = '<base href="' . esc_url(plugins_url('ui/', self::pluginFile())) . '">' . "\n"
            . '<script>window.HermesQueue = ' . wp_json_encode($config, JSON_UNESCAPED_SLASHES | JSON_HEX_TAG | JSON_HEX_AMP) . ';</script>';
        $html = preg_replace('~<head>~', "<head>\n" . $head, (string) file_get_contents($file), 1);
        nocache_headers();
        header('Content-Type: text/html; charset=utf-8');
        header('X-Frame-Options: SAMEORIGIN');
        header("Content-Security-Policy: frame-ancestors 'self'");
        echo $html;
        exit;
    }

    private static function pluginFile(): string
    {
        return dirname(__DIR__) . '/hermes-approval.php';
    }

    private static function uiDir(): string
    {
        return dirname(__DIR__) . '/ui/';
    }
}
