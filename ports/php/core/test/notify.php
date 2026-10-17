<?php
declare(strict_types=1);

/**
 * Decision notifications in the PHP core, without phpunit: `php ports/php/core/test/notify.php`.
 * Exit code 0 = every check passed. The core has no other PHP unit tests yet; this one runs the real ApprovalService
 * against an in-memory store, so it also covers submit, decide and execute on the way.
 */

use Hermes\Approval\ApprovalException;
use Hermes\Approval\ApprovalService;
use Hermes\Approval\CmsAdapter;
use Hermes\Approval\JObject;
use Hermes\Approval\Json;
use Hermes\Approval\Notifier;
use Hermes\Approval\Profile;
use Hermes\Approval\Row;
use Hermes\Approval\Status;
use Hermes\Approval\Store\ApprovalStore;
use Hermes\Approval\Webhook;

spl_autoload_register(static function (string $class): void {
    $prefix = 'Hermes\\Approval\\';
    if (strncmp($class, $prefix, strlen($prefix)) === 0) {
        $file = __DIR__ . '/../src/' . str_replace('\\', '/', substr($class, strlen($prefix))) . '.php';
        if (is_file($file)) {
            require_once $file;
        }
    }
});

final class MemoryStore implements ApprovalStore
{
    /** @var array<int,Row> */
    public array $rows = [];
    private int $last = 1000;

    public function insert(array $v): Row
    {
        $id = ++$this->last;
        $this->rows[$id] = new Row($id, $v['siteId'], $v['resourceType'], $v['resourceId'], $v['action'], $v['scope'], $v['status'],
            (string) $v['reason'], $v['proposal'], null, false, null, $v['revisionOfApprovalId'], $v['createdUtc'], null, null, $v['expiresUtc']);
        return clone $this->rows[$id];
    }

    public function get(int $id): ?Row
    {
        return isset($this->rows[$id]) ? clone $this->rows[$id] : null;
    }

    public function list(?array $statuses = null): array
    {
        return array_values(array_map(static fn (Row $r) => clone $r, array_filter($this->rows, static fn (Row $r) => $statuses === null || in_array($r->status, $statuses, true))));
    }

    public function transition(int $id, string $from, array $patch): ?Row
    {
        $row = $this->rows[$id] ?? null;
        if ($row === null || $row->status !== $from) {
            return null;
        }
        foreach ($patch as $key => $value) {
            $row->$key = $value;
        }
        return clone $row;
    }

    public function consume(int $id, string $nowUtc, callable $apply): array
    {
        $row = $this->rows[$id] ?? null;
        if ($row === null || $row->status !== Status::APPROVED) {
            return [null, null];
        }
        $row->status = Status::CONSUMED;
        return [clone $row, $apply(clone $row)];
    }
}

final class NullCms implements CmsAdapter
{
    public function read(int $siteId, string $resourceType, int|float|string $resourceId): JObject|null
    {
        return null;
    }

    public function apply(Row $row): mixed
    {
        return ['ok' => true];
    }
}

final class RecordingNotifier implements Notifier
{
    /** @var list<Row> */
    public array $seen = [];

    public function __construct(private readonly bool $throws = false, private readonly bool $signed = true)
    {
    }

    public function decided(Row $row): void
    {
        $this->seen[] = $row;
        if ($this->throws) {
            throw new \RuntimeException('the receiver is down');
        }
    }

    public function signed(): bool
    {
        return $this->signed;
    }
}

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
function refused(callable $fn): ?string
{
    try {
        $fn();
        return null;
    } catch (ApprovalException $e) {
        return $e->errorCode;
    }
}

$reviewer = ['id' => 'manager'];
$submission = static fn (): JObject => Json::parse('{"resourceType":"post","resourceId":42,"action":"update:canonical","scope":"seo:write","reason":"why-marker","proposal":{"canonical":"https://example.com/c"}}');
$service = static fn (?Notifier $n): ApprovalService => ApprovalService::create(new MemoryStore(), new NullCms(), Profile::seo(), 86400, $n);

// ---- the wire format -------------------------------------------------------------------------------------------------
$row = new Row(1042, 1, 'post', 42, 'update:canonical', 'seo:write', Status::APPROVED, 'r', JObject::from(['secret' => 'must not leak']), null, false, 'note', null,
    '2026-10-16T01:00:00.000Z', '2026-10-16T01:40:12.345Z', 'manager', '2026-10-17T01:00:00.000Z');
$body = Webhook::body($row);
check('the body is compact JSON with four fields in a fixed order', $body === '{"event":"decision","approvalId":1042,"status":"Approved","decidedUtc":"2026-10-16T01:40:12.345Z"}', $body);
check('the body carries nothing from the proposal', !str_contains($body, 'leak'));
// Same vector as docs/spec.md; computed with Node, OpenSSL and PHP.
check('the signature matches the published test vector',
    Webhook::sign('s3cret', '1760580012', $body) === 'sha256=8bd76bf7597eacb8a5c71c7b0485d267471f99bd208bc604aa570511a236f684');
$signedHeaders = Webhook::headers('s3cret', $body, 1760580012);
check('a signed delivery has timestamp and signature', ($signedHeaders['X-Hermes-Timestamp'] ?? '') === '1760580012' && ($signedHeaders['X-Hermes-Signature'] ?? '') === Webhook::sign('s3cret', '1760580012', $body));
$unsigned = Webhook::headers('', $body);
check('an unsigned delivery has neither', !isset($unsigned['X-Hermes-Timestamp']) && !isset($unsigned['X-Hermes-Signature']));
check('every delivery has its own id and the JSON content type', preg_match('/^[0-9a-f]{32}$/', $unsigned['X-Hermes-Delivery']) === 1
    && $unsigned['X-Hermes-Delivery'] !== Webhook::headers('', $body)['X-Hermes-Delivery'] && $unsigned['Content-Type'] === 'application/json');
$urls = ['http://127.0.0.1:8795/hook' => true, 'https://agent.example/hooks/hermes?x=1' => true, 'ftp://example.com/x' => false, 'file:///etc/passwd' => false,
    'http://user:pw@example.com/x' => false, 'not a url' => false, '' => false, '//example.com/x' => false];
foreach ($urls as $url => $valid) {
    check("receiver url \"$url\" is " . ($valid ? 'accepted' : 'refused'), Webhook::isValidUrl((string) $url) === $valid);
}

// ---- the service -----------------------------------------------------------------------------------------------------
foreach (['approve' => 'Approved', 'reject' => 'Rejected', 'request-changes' => 'ChangesRequested'] as $verb => $status) {
    $n = new RecordingNotifier();
    $svc = $service($n);
    $submitted = $svc->submit($submission());
    check("$verb: a submit announces nothing", $n->seen === []);
    $decided = $svc->decide($submitted->approvalId, $verb, $reviewer, 'because', false, null);
    check("$verb: announced once, with the stored row", count($n->seen) === 1 && $n->seen[0]->approvalId === $submitted->approvalId
        && $n->seen[0]->status === $status && $n->seen[0]->decidedUtc === $decided->decidedUtc);
}

$n = new RecordingNotifier();
$svc = $service($n);
$a = $svc->submit($submission());
$codes = [
    refused(fn () => $svc->decide($a->approvalId, 'reject', $reviewer, '', false, null)),
    refused(fn () => $svc->decide($a->approvalId, 'request-changes', $reviewer, null, false, null)),
    refused(fn () => $svc->decide($a->approvalId, 'approve', null, '', false, null)),
    refused(fn () => $svc->decide($a->approvalId, 'approve', $reviewer, 42, false, null)),
    refused(fn () => $svc->decide($a->approvalId, 'bogus', $reviewer, '', false, null)),
];
check('refused decisions announce nothing', $n->seen === [] && !in_array(null, $codes, true), json_encode($codes));
$svc->decide($a->approvalId, 'approve', $reviewer, '', false, null);
$again = [refused(fn () => $svc->decide($a->approvalId, 'approve', $reviewer, '', false, null)), refused(fn () => $svc->decide($a->approvalId, 'reject', $reviewer, 'late', false, null))];
$svc->execute(Json::parse('{"approvalId":' . $a->approvalId . ',"resourceType":"post","resourceId":42,"action":"update:canonical","scope":"seo:write","proposal":{"canonical":"https://example.com/c"}}'));
check('a repeated decision and a write add nothing', count($n->seen) === 1 && $again === ['APPROVAL_NOT_PENDING', 'APPROVAL_NOT_PENDING']);

$boom = new RecordingNotifier(throws: true);
$svc = $service($boom);
$b = $svc->submit($submission());
$result = $svc->decide($b->approvalId, 'approve', $reviewer, '', false, null);
check('a notifier that throws never undoes or fails the decision', $result->status === Status::APPROVED && $svc->get($b->approvalId)->status === Status::APPROVED && count($boom->seen) === 1);

check('the manifest note is absent without a notifier', $service(null)->notifications() === null);
check('the manifest note says signed', $service(new RecordingNotifier(signed: true))->notifications() === ['decision' => true, 'signed' => true]);
check('the manifest note says unsigned', $service(new RecordingNotifier(signed: false))->notifications() === ['decision' => true, 'signed' => false]);

echo "\n" . ($total - $failures) . " of $total passed\n";
exit($failures === 0 ? 0 : 1);
