<?php
declare(strict_types=1);

namespace Hermes\Approval\Wp;

use Hermes\Approval\ApprovalException;
use Hermes\Approval\ApprovalService;
use Hermes\Approval\JObject;
use Hermes\Approval\Json;
use Hermes\Approval\Http\Request;
use Hermes\Approval\Row;
use Hermes\Approval\Status;
use Hermes\Approval\Time;

/** Route table: method + path -> door check -> service call, wrapped in the spec's JSON envelope. */
final class RestApi
{
    private const MAX_BODY_BYTES = 200000;

    public static function handle(\WP_REST_Request $request, ApprovalService $service, WpDoors $doors): \WP_REST_Response
    {
        try {
            $data = self::route($request, $service, $doors);
            return self::respond(200, ['success' => true, 'data' => $data]);
        } catch (ApprovalException $e) {
            return self::respond($e->httpStatus(), self::error($e->errorCode, $e->getMessage()));
        } catch (\Throwable $e) {
            error_log('[hermes-approval] ' . get_class($e) . ': ' . $e->getMessage() . ' in ' . $e->getFile() . ':' . $e->getLine());
            return self::respond(500, self::error('INTERNAL', 'Unexpected server error.'));
        }
    }

    /** rest_pre_serve_request: print our pre-encoded JSON instead of letting WordPress re-encode it. */
    public static function serve(bool $served, $result, $request, $server): bool
    {
        if ($request instanceof \WP_REST_Request && Plugin::isOurs($request) && !headers_sent()) {
            // WordPress reflects any Origin with credentials allowed. The agent API is not for browsers on other sites:
            // send nothing unless an origin is configured on purpose.
            foreach (['Access-Control-Allow-Origin', 'Access-Control-Allow-Credentials', 'Access-Control-Allow-Methods'] as $h) {
                header_remove($h);
            }
            if (defined('HERMES_APPROVAL_CORS_ORIGIN') && HERMES_APPROVAL_CORS_ORIGIN !== '') {
                header('Access-Control-Allow-Origin: ' . HERMES_APPROVAL_CORS_ORIGIN);
                header('Access-Control-Allow-Headers: Content-Type, X-Api-Key, X-WP-Nonce');
                header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
            }
        }
        if (!$served && $result instanceof \WP_HTTP_Response && $result->get_data() instanceof RawJson) {
            echo $result->get_data()->json;
            return true;
        }
        return $served;
    }

    private static function route(\WP_REST_Request $request, ApprovalService $svc, WpDoors $doors): mixed
    {
        $method = $request->get_method();
        $path = self::relativePath($request);
        Request::assertNoNul($path);
        $query = (string) ($_SERVER['QUERY_STRING'] ?? '');
        $agent = $doors->agent($request);
        $reviewer = $doors->reviewer();
        $needRead = static function () use ($agent, $reviewer): void {
            if (!$agent['read'] && $reviewer === null) {
                throw ApprovalException::of('UNAUTHORIZED', 'Read key or review session required.');
            }
        };

        if ($method === 'GET' && $path === '/ping') {
            return ['ok' => true, 'utc' => Time::iso($svc->now())];
        }
        if ($method === 'GET' && $path === '/manifest') {
            $needRead();
            $p = $svc->profile;
            $manifest = [
                'version' => '2.0', 'baseUrl' => rest_url(Plugin::NAMESPACE), 'authHeader' => 'X-Api-Key',
                'actions' => $p->actions, 'scopes' => $p->scopes, 'approvalLifecycle' => Status::LIFECYCLE,
                'limits' => ['maxFields' => $p->maxFields, 'maxJsonChars' => $p->maxJsonChars, 'maxReasonChars' => $p->maxReasonChars],
                // Optional in the spec: the fields each action can write, so the agent does not have to guess them.
                'fields' => WpCmsAdapter::fields(),
            ];
            // Optional in the spec: present only when the operator set HERMES_APPROVAL_WEBHOOK_URL.
            if ($svc->notifications() !== null) {
                $manifest['notifications'] = $svc->notifications();
            }
            return $manifest;
        }
        if ($method === 'GET' && preg_match('~^/resources/([^/]+)/([^/]+)$~D', $path, $m)) {
            $needRead();
            return $svc->readResource(Request::siteId($query), Request::decodeSegment($m[1]), Request::pathId(Request::decodeSegment($m[2])));
        }
        if ($method === 'GET' && $path === '/proposals') {
            if ($reviewer === null) {
                throw ApprovalException::of('SCOPE_DENIED', 'Listing is a review-door call.');
            }
            $rows = $svc->list(Request::status($query));
            return array_map(static fn (Row $r) => $r->toDto(), $rows);
        }
        if ($method === 'GET' && preg_match('~^/proposals/([0-9]+)$~D', $path, $m)) {
            $needRead();
            return $svc->get(self::id($m[1]))->toDto();
        }
        if ($method === 'POST' && $path === '/proposals') {
            if (!$agent['write']) {
                throw ApprovalException::of('SCOPE_DENIED', 'Submit requires the write key.');
            }
            return $svc->submit(self::body($request))->toDto();
        }
        if ($method === 'POST' && preg_match('~^/proposals/([0-9]+)/(approve|reject|request-changes)$~D', $path, $m)) {
            if ($agent['write']) {
                throw ApprovalException::of('SCOPE_DENIED', 'The write key cannot approve.');
            }
            if ($reviewer === null) {
                throw ApprovalException::of('SCOPE_DENIED', 'Decide requires a review session.');
            }
            $body = self::body($request);
            if (!$body instanceof JObject) {
                throw ApprovalException::of('BAD_REQUEST', 'Request body must be a JSON object.');
            }
            return $svc->decide(self::id($m[1]), $m[2], $reviewer, $body->get('reason'), $body->has('proposal'), $body->get('proposal'))->toDto();
        }
        if ($method === 'POST' && $path === '/writes') {
            if (!$agent['write']) {
                throw ApprovalException::of('SCOPE_DENIED', 'Writes require the write key.');
            }
            return $svc->execute(self::body($request));
        }
        throw ApprovalException::of('NOT_FOUND', 'No such route.');
    }

    /** An id too large for an integer cannot exist, so it is "not found", not a server error. */
    private static function id(string $digits): int
    {
        $trimmed = ltrim($digits, '0');
        if (strlen($trimmed) > 18) {
            throw ApprovalException::of('NOT_FOUND', 'No proposal with that id.');
        }
        return (int) $trimmed;
    }

    /**
     * The path after the namespace, exactly as sent (still percent-encoded, trailing slash kept). WordPress hands over
     * a decoded route with the trailing slash removed, which would make this API more lenient than the other stacks.
     */
    private static function relativePath(\WP_REST_Request $request): string
    {
        $path = explode('?', (string) ($_SERVER['REQUEST_URI'] ?? ''), 2)[0];
        $needle = '/' . rest_get_url_prefix() . '/' . Plugin::NAMESPACE;
        $at = strpos($path, $needle);
        if ($at !== false) {
            $rest = substr($path, $at + strlen($needle));
            return $rest === '' ? '/' : $rest;
        }
        // Plain permalinks (?rest_route=/hermes-approval/v1/...): WordPress has already decoded the route.
        return '/' . ltrim(substr($request->get_route(), strlen('/' . Plugin::NAMESPACE)), '/');
    }

    /** UTF-8 JSON body with a size cap. An empty body is an empty object. */
    private static function body(\WP_REST_Request $request): mixed
    {
        // PHP never exposes a multipart/form-data body in php://input, so the type is judged before the body is looked at.
        $type = Request::contentType($request->get_header('content_type'));
        Request::assertJsonBody($type);
        $raw = (string) $request->get_body();
        if (strlen($raw) > self::MAX_BODY_BYTES) {
            throw ApprovalException::of('PAYLOAD_TOO_LARGE', 'Request body is too large.');
        }
        Request::assertJsonBody($type, $raw);
        return $raw === '' ? new JObject() : Json::parse($raw);
    }

    private static function error(string $code, string $message): array
    {
        return ['success' => false, 'error' => ['code' => $code, 'message' => $message]];
    }

    private static function respond(int $status, array $body): \WP_REST_Response
    {
        $response = new \WP_REST_Response(new RawJson(Json::encode($body)), $status);
        $response->header('Cache-Control', 'no-store');
        return $response;
    }
}
