<?php
/**
 * Plugin Name: Hermes Approval Queue
 * Description: Lets an AI agent propose reads, writes and deletes over a REST API. Nothing runs until a signed-in reviewer approves it; the agent then redeems the exact approved JSON once.
 * Version:     0.1.0
 * Requires PHP: 8.1
 * License:     Apache-2.0
 * License URI: https://www.apache.org/licenses/LICENSE-2.0
 *
 * Configuration (wp-config.php):
 *   define( 'HERMES_APPROVAL_READ_KEYS',  'key-a,key-b' );      // agent keys that may read
 *   define( 'HERMES_APPROVAL_WRITE_KEYS', 'key-c' );            // agent keys that may submit and redeem (never approve)
 *   define( 'HERMES_APPROVAL_REVIEW_CAP', 'edit_others_posts' ); // capability a reviewer needs (default shown)
 *   define( 'HERMES_APPROVAL_WEBHOOK_URL',    'https://agent.example/hooks/hermes' ); // optional: tell the agent's server when a person decides
 *   define( 'HERMES_APPROVAL_WEBHOOK_SECRET', 'a long random string' );               // optional: sign those notifications
 *
 * Reviewers are ordinary WordPress users: cookie + X-WP-Nonce from the admin, or an Application Password.
 * The agent's keys are never accepted for approving, whatever else is sent with them.
 */

defined( 'ABSPATH' ) || exit;

// The framework-free core ships in lib/ (copy ports/php/core/src there); in this repository it sits two folders up.
spl_autoload_register( static function ( string $class ): void {
    $prefix = 'Hermes\\Approval\\';
    if ( strncmp( $class, $prefix, strlen( $prefix ) ) !== 0 ) {
        return;
    }
    $relative = str_replace( '\\', '/', substr( $class, strlen( $prefix ) ) );
    foreach ( [ __DIR__ . '/lib/', __DIR__ . '/../../core/src/', __DIR__ . '/src/' ] as $root ) {
        if ( is_file( $root . $relative . '.php' ) ) {
            require_once $root . $relative . '.php';
            return;
        }
    }
} );

require_once __DIR__ . '/src/Plugin.php';

register_activation_hook( __FILE__, [ \Hermes\Approval\Wp\Plugin::class, 'activate' ] );
\Hermes\Approval\Wp\Plugin::boot();
