<?php
// Settings for a THROWAWAY test site. Copy to <wordpress>/wp-config.php and edit the database lines.
// None of these keys or salts are secrets: they must never be reused on a real site.
define( 'DB_NAME', 'wp' );
define( 'DB_USER', 'wp' );
define( 'DB_PASSWORD', 'change-me' );
define( 'DB_HOST', '127.0.0.1' );
define( 'DB_CHARSET', 'utf8mb4' );
define( 'DB_COLLATE', '' );
define( 'AUTH_KEY', 'test-only-1' ); define( 'SECURE_AUTH_KEY', 'test-only-2' ); define( 'LOGGED_IN_KEY', 'test-only-3' ); define( 'NONCE_KEY', 'test-only-4' );
define( 'AUTH_SALT', 'test-only-5' ); define( 'SECURE_AUTH_SALT', 'test-only-6' ); define( 'LOGGED_IN_SALT', 'test-only-7' ); define( 'NONCE_SALT', 'test-only-8' );
$table_prefix = 'wp_';

define( 'WP_ENVIRONMENT_TYPE', 'local' );   // lets Application Passwords work over plain http on 127.0.0.1; setup.php requires it
define( 'WP_DEBUG', true );                 // surface every notice in the log...
define( 'WP_DEBUG_DISPLAY', false );        // ...but never in a response
define( 'WP_DEBUG_LOG', '/tmp/wp-debug.log' );
define( 'DISABLE_WP_CRON', true );
define( 'AUTOMATIC_UPDATER_DISABLED', true );
define( 'WP_HTTP_BLOCK_EXTERNAL', true );

// The agent's keys. Use long random values on a real site; several keys may be given, separated by commas.
define( 'HERMES_APPROVAL_READ_KEYS', 'demo-read' );
define( 'HERMES_APPROVAL_WRITE_KEYS', 'demo-write' );

if ( ! defined( 'ABSPATH' ) ) define( 'ABSPATH', __DIR__ . '/' );
require_once ABSPATH . 'wp-settings.php';
