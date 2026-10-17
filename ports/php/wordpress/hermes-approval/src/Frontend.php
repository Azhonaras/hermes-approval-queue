<?php
declare(strict_types=1);

namespace Hermes\Approval\Wp;

/**
 * Makes the approved SEO fields count on the live site. The adapter saves them as post meta (_hermes_title_seo, ...),
 * and WordPress itself never reads those keys: without this class an approved canonical or meta description is saved,
 * reported as done, and never seen by a visitor or a search engine.
 *
 * An active SEO plugin owns these tags, so then this class prints nothing (two canonicals are worse than one); point the
 * adapter's meta keys at that plugin instead (README, "What an action does"). Filter `hermes_approval_frontend` to decide.
 */
final class Frontend
{
    public static function boot(): void
    {
        add_action('wp', [self::class, 'register']);
    }

    public static function register(): void
    {
        if (is_admin() || !self::enabled()) {
            return;
        }
        add_action('template_redirect', [self::class, 'redirect'], 1);
        add_filter('pre_get_document_title', [self::class, 'title'], 20);
        add_filter('get_canonical_url', [self::class, 'canonical'], 20, 2);
        add_filter('wp_robots', [self::class, 'robots'], 20);
        add_action('wp_head', [self::class, 'head'], 1);
    }

    public static function enabled(): bool
    {
        $seoPlugin = defined('WPSEO_VERSION') || defined('RANK_MATH_VERSION') || defined('AIOSEO_VERSION')
            || defined('SEOPRESS_VERSION') || defined('THE_SEO_FRAMEWORK_VERSION');
        return (bool) apply_filters('hermes_approval_frontend', !$seoPlugin);
    }

    /** The post this request shows, or 0 (archives, search and feeds are left alone). */
    private static function postId(): int
    {
        return is_singular() ? (int) get_queried_object_id() : 0;
    }

    private static function meta(string $key): string
    {
        $id = self::postId();
        return $id > 0 ? (string) get_post_meta($id, $key, true) : '';
    }

    public static function redirect(): void
    {
        $to = self::meta('_hermes_redirect');
        if ($to !== '' && preg_match('~^https?://\S+$~D', $to) && wp_redirect($to, 301, 'Hermes Approval')) {
            exit;
        }
    }

    /** pre_get_document_title skips WordPress's own escaping of the title, so escape here: approved text is never markup. */
    public static function title(string $title): string
    {
        $seo = self::meta('_hermes_title_seo');
        return $seo !== '' ? esc_html($seo) : $title;
    }

    public static function canonical(string|false $url, \WP_Post $post): string|false
    {
        if ($post->ID !== self::postId()) {
            return $url;
        }
        $approved = (string) get_post_meta($post->ID, '_hermes_canonical', true);
        return $approved !== '' ? $approved : $url; // rel_canonical() prints it through esc_url()
    }

    /** @param array<string, bool|string> $robots */
    public static function robots(array $robots): array
    {
        if (self::meta('_hermes_noindex') === '1') {
            unset($robots['index']);
            $robots['noindex'] = true;
        }
        return $robots;
    }

    public static function head(): void
    {
        $description = self::meta('_hermes_description_seo');
        if ($description !== '') {
            echo '<meta name="description" content="' . esc_attr($description) . '" />' . "\n";
        }
        $schema = self::meta('_hermes_schema');
        $data = $schema !== '' ? json_decode($schema) : null;
        if ($data !== null) {
            // JSON_HEX_TAG writes < and > as < and >, so an approved value cannot close the script element.
            $json = wp_json_encode($data, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_HEX_TAG | JSON_HEX_AMP);
            if (is_string($json)) {
                echo '<script type="application/ld+json">' . $json . "</script>\n";
            }
        }
    }
}
