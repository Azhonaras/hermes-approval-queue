<?php
declare(strict_types=1);

/**
 * Request-parsing rules of the PHP core, without phpunit: `php ports/php/core/test/request.php`.
 * Exit code 0 = every check passed.
 */

use Hermes\Approval\ApprovalException;
use Hermes\Approval\Http\Request;

spl_autoload_register(static function (string $class): void {
    $prefix = 'Hermes\\Approval\\';
    if (strncmp($class, $prefix, strlen($prefix)) === 0) {
        $file = __DIR__ . '/../src/' . str_replace('\\', '/', substr($class, strlen($prefix))) . '.php';
        if (is_file($file)) {
            require_once $file;
        }
    }
});

$failures = 0;
$total = 0;
function check(string $name, bool $ok, string $detail = ''): void
{
    global $failures, $total;
    $total++;
    if (!$ok) {
        $failures++;
        echo "FAIL  $name" . ($detail !== '' ? "\n      $detail" : '') . "\n";
    } else {
        echo "ok    $name\n";
    }
}
function code(callable $fn): ?string
{
    try {
        $fn();
        return null;
    } catch (ApprovalException $e) {
        return $e->errorCode;
    }
}

// ---- Content-Type -----------------------------------------------------------------------------------------------------
foreach (['fpm-fcgi', 'cgi-fcgi', 'cgi', 'litespeed'] as $sapi) {
    check("$sapi: an empty CONTENT_TYPE means the request had none", Request::contentType('', $sapi) === null);
}
foreach (['cli-server', 'apache2handler', 'some-future-sapi'] as $sapi) {
    check("$sapi: an empty Content-Type is a type like any other", Request::contentType('', $sapi) === '');
}
check('a real type is never changed', Request::contentType('text/plain', 'fpm-fcgi') === 'text/plain' && Request::contentType('application/json', 'cli-server') === 'application/json');
check('no header stays none', Request::contentType(null, 'fpm-fcgi') === null && Request::contentType(null, 'cli-server') === null);

check('no Content-Type and no body is accepted', code(fn () => Request::assertJsonBody(null, '')) === null);
check('no Content-Type with a body is a 415', code(fn () => Request::assertJsonBody(null, '{}')) === 'UNSUPPORTED_MEDIA_TYPE');
check('an empty Content-Type is a 415 where PHP can tell, even for an empty body', code(fn () => Request::assertJsonBody(Request::contentType('', 'cli-server'))) === 'UNSUPPORTED_MEDIA_TYPE');
check('an empty CONTENT_TYPE under FPM with a body is a 415', code(fn () => Request::assertJsonBody(Request::contentType('', 'fpm-fcgi'), '{}')) === 'UNSUPPORTED_MEDIA_TYPE');
check('parameters and case do not matter', code(fn () => Request::assertJsonBody('APPLICATION/JSON; charset=utf-8', '{}')) === null);
check('text/plain is a 415 before the body is even read, so also for an empty body', code(fn () => Request::assertJsonBody('text/plain')) === 'UNSUPPORTED_MEDIA_TYPE');

echo "\n" . ($total - $failures) . " of $total passed\n";
exit($failures === 0 ? 0 : 1);
