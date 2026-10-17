<?php
/**
 * One-time setup for a THROWAWAY WordPress test site. Never run this against a real site: it creates users,
 * application passwords and a fixture approval.
 *
 *   HERMES_WP_ROOT=/path/to/wordpress HERMES_WP_URL=http://127.0.0.1:8792 php setup.php
 *
 * It installs WordPress when needed, activates the plugin, and creates:
 *   manager   an editor: the reviewer
 *   writer    an author: may not approve
 *   limited   may approve (edit_others_posts) but may not edit published posts: approvals must not lift that limit
 *   post 42   a published post, and a category "Skin care"
 *   approval 1036, already past its expiry (the conformance suite's `expiredFixture`)
 * and writes two files:
 *   HERMES_PROFILE_OUT  the conformance profile for this site   (default: <repo>/conformance/profiles/wordpress.local.json)
 *   HERMES_CREDS_OUT    credentials for real-scenarios.mjs      (default: ./wp-creds.local.json)
 * Both hold live credentials of the test site. They are git-ignored; do not commit or share them.
 *
 * wp-config.php must define HERMES_APPROVAL_READ_KEYS and HERMES_APPROVAL_WRITE_KEYS, and WP_ENVIRONMENT_TYPE as
 * "local" (the script refuses otherwise, and application passwords need it over plain http). If it also defines
 * HERMES_APPROVAL_WEBHOOK_URL on 127.0.0.1 or localhost, the profile gets a `notify` block so the suite listens there.
 */
$root = rtrim((string) (getenv('HERMES_WP_ROOT') ?: ''), '/\\');
$url = rtrim((string) (getenv('HERMES_WP_URL') ?: 'http://127.0.0.1:8792'), '/');
if ($root === '' || !is_file($root . '/wp-load.php')) {
    fwrite(STDERR, "Set HERMES_WP_ROOT to the folder that holds wp-load.php.\n");
    exit(2);
}
$profileOut = getenv('HERMES_PROFILE_OUT') ?: dirname(__DIR__, 4) . '/conformance/profiles/wordpress.local.json';
$credsOut = getenv('HERMES_CREDS_OUT') ?: __DIR__ . '/wp-creds.local.json';

define('WP_INSTALLING', true);
$parts = parse_url($url);
$_SERVER['HTTP_HOST'] = $parts['host'] . (isset($parts['port']) ? ':' . $parts['port'] : '');
require $root . '/wp-load.php';
require_once ABSPATH . 'wp-admin/includes/upgrade.php';

if (!in_array(wp_get_environment_type(), ['local', 'development'], true)) {
    fwrite(STDERR, "Refusing to run: WP_ENVIRONMENT_TYPE must be 'local' or 'development' (this is a test-site tool).\n");
    exit(2);
}

if (!is_blog_installed()) {
    wp_install('Hermes test site', 'admin', 'admin@example.test', false, '', wp_generate_password(24));
}
update_option('siteurl', $url);
update_option('home', $url);
update_option('permalink_structure', '/%postname%/');
flush_rewrite_rules();
activate_plugin('hermes-approval/hermes-approval.php');
if (!class_exists(\Hermes\Approval\Wp\Plugin::class)) {
    require_once WP_PLUGIN_DIR . '/hermes-approval/hermes-approval.php'; // plugins are not loaded while WP_INSTALLING
}
\Hermes\Approval\Wp\Plugin::activate();

$user = static function (string $login, string $role): WP_User {
    $u = get_user_by('login', $login) ?: get_user_by('id', wp_create_user($login, wp_generate_password(24), $login . '@example.test'));
    $u->set_role($role);
    return $u;
};
if (!get_role('seo_reviewer')) {
    add_role('seo_reviewer', 'SEO reviewer', ['read' => true, 'edit_posts' => true, 'edit_others_posts' => true]);
}
$manager = $user('manager', 'editor');
$writer = $user('writer', 'author');
$limited = $user('limited', 'seo_reviewer');

$out = [];
foreach (['manager' => $manager, 'writer' => $writer, 'limited' => $limited] as $name => $u) {
    WP_Application_Passwords::delete_all_application_passwords($u->ID);
    [$pass] = WP_Application_Passwords::create_new_application_password($u->ID, ['name' => 'conformance']);
    $out[$name] = base64_encode($u->user_login . ':' . $pass);
}

if (!get_post(42)) {
    wp_insert_post(['import_id' => 42, 'post_type' => 'post', 'post_status' => 'publish', 'post_title' => 'Sample guide', 'post_content' => 'Body']);
}
update_post_meta(42, '_hermes_canonical', '');
$cat = term_exists('Skin care', 'category') ?: wp_insert_term('Skin care', 'category');
$out['post'] = 42;
$out['term'] = (int) $cat['term_id'];

global $wpdb;
$table = \Hermes\Approval\Wp\WpdbStore::table();
$wpdb->query("DELETE FROM $table WHERE approval_id = 1036");
$wpdb->query("INSERT INTO $table (approval_id, site_id, resource_type, resource_id_json, action, scope, status, reason, proposal_json, edited_proposal, created_utc, decided_utc, decided_by, expires_utc)
  VALUES (1036, 1, 'page', '77', 'update:onpage', 'seo:write', 'Approved', 'Approval expired before the agent redeemed it.', '{\"titleSeo\":\"Expired sample\"}', 0, '2020-01-01 09:00:00', '2020-01-01 09:10:00', 'manager', '2020-01-02 09:00:00')");

// A browser session for the manager: the logged-in cookie and the REST nonce that must go with it.
$token = WP_Session_Tokens::get_instance($manager->ID)->create(time() + 86400);
$cookie = wp_generate_auth_cookie($manager->ID, time() + 86400, 'logged_in', $token);
$_COOKIE[LOGGED_IN_COOKIE] = $cookie; // wp_create_nonce() takes the session token from here
wp_set_current_user($manager->ID);
// COOKIEHASH is empty while the database has no siteurl yet (the first run on a fresh site), so LOGGED_IN_COOKIE can be
// wrong by now. The browser's cookie is named from the site URL.
$out['cookie'] = 'wordpress_logged_in_' . md5($url) . '=' . $cookie;
$out['nonce'] = wp_create_nonce('wp_rest');
if (file_put_contents($credsOut, json_encode($out)) === false) {
    fwrite(STDERR, "Cannot write $credsOut\n");
    exit(1);
}

$firstKey = static function (string $constant, string $fallback): string {
    $keys = defined($constant) ? array_filter(array_map('trim', explode(',', (string) constant($constant)))) : [];
    return $keys ? reset($keys) : $fallback;
};
$api = $url . '/wp-json/hermes-approval/v1';
$profile = [
    'baseUrl' => $api,
    'writeHeader' => 'X-Api-Key: ' . $firstKey('HERMES_APPROVAL_WRITE_KEYS', 'demo-write'),
    'readHeader' => 'X-Api-Key: ' . $firstKey('HERMES_APPROVAL_READ_KEYS', 'demo-read'),
    'reviewHeaders' => ['Authorization: Basic ' . $out['manager']],
    'resourceType' => 'post', 'resourceId' => 42, 'action' => 'update:canonical', 'scope' => 'seo:write',
    'payload' => ['canonical' => 'https://example.com/c-{{uid}}'],
    'otherAction' => 'update:redirect', 'otherScope' => 'content:update', 'deleteAction' => 'delete:taxonomy',
    'verifyUrl' => $api . '/resources/post/42', 'verifyField' => 'canonical',
    'verifyHeaders' => ['X-Api-Key: ' . $firstKey('HERMES_APPROVAL_READ_KEYS', 'demo-read')],
    // The second field is refused by the plugin AFTER the first has been saved, so the check proves the rollback.
    'failingPayload' => ['canonical' => 'https://example.com/partial-must-not-survive', 'redirect' => 'not a url'],
    'expiredFixture' => ['approvalId' => 1036, 'resourceType' => 'page', 'resourceId' => 77, 'action' => 'update:onpage', 'scope' => 'seo:write', 'proposal' => ['titleSeo' => 'Expired sample']],
];
// Decision notifications: when wp-config.php sends them to a port on this machine, the profile tells the suite to listen there
// and run the notify group (HERMES_APPROVAL_WEBHOOK_URL / _SECRET in wp-config.php are the only place the receiver is set).
if (defined('HERMES_APPROVAL_WEBHOOK_URL') && HERMES_APPROVAL_WEBHOOK_URL !== '') {
    $hook = parse_url((string) HERMES_APPROVAL_WEBHOOK_URL);
    if (isset($hook['port']) && in_array($hook['host'] ?? '', ['127.0.0.1', 'localhost'], true)) {
        $profile['notify'] = ['port' => (int) $hook['port'], 'secret' => defined('HERMES_APPROVAL_WEBHOOK_SECRET') ? (string) HERMES_APPROVAL_WEBHOOK_SECRET : ''];
    }
}
if (file_put_contents($profileOut, json_encode($profile, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES) . "\n") === false) {
    fwrite(STDERR, "Cannot write $profileOut\n");
    exit(1);
}
echo json_encode(['ok' => true, 'wordpress' => get_bloginfo('version'), 'post' => 42, 'term' => $out['term'], 'profile' => $profileOut, 'creds' => $credsOut]), "\n";
