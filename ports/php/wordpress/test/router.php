<?php
// Router for `php -S` (PHP's built-in server): serves real files, sends everything else to WordPress,
// which is what .htaccess does on Apache. Test sites only.
//
//   cd /path/to/wordpress && PHP_CLI_SERVER_WORKERS=16 php -S 127.0.0.1:8792 /path/to/router.php
//
// PHP_CLI_SERVER_WORKERS makes the server handle requests in parallel, like php-fpm, so the concurrency checks are real.
$path = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
$file = $_SERVER['DOCUMENT_ROOT'] . $path;
if ($path !== '/' && is_file($file) && !str_ends_with($path, '.php')) {
    return false;
}
// A folder is its index.php, as on Apache and nginx: without this, /wp-admin/ (where the login lands) showed the blog.
if ($path !== '/' && is_dir($file)) {
    if (!str_ends_with($path, '/')) {
        header('Location: ' . $path . '/' . (isset($_SERVER['QUERY_STRING']) && $_SERVER['QUERY_STRING'] !== '' ? '?' . $_SERVER['QUERY_STRING'] : ''), true, 301);
        return;
    }
    if (is_file($file . 'index.php')) {
        $path .= 'index.php';
        $file .= 'index.php';
        $_SERVER['SCRIPT_NAME'] = $_SERVER['PHP_SELF'] = $path;
    }
}
if (str_ends_with($path, '.php') && is_file($file)) {
    require $file;
    return;
}
$_SERVER['SCRIPT_NAME'] = '/index.php';
require $_SERVER['DOCUMENT_ROOT'] . '/index.php';
