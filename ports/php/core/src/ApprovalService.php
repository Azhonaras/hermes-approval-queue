<?php
declare(strict_types=1);

namespace Hermes\Approval;

use Hermes\Approval\Store\ApprovalStore;

/** Every use case of the approval queue, independent of HTTP. Dependencies are injected so each can be swapped. */
final class ApprovalService
{
    /** @param \Closure():float $clock unix seconds */
    public function __construct(
        private readonly ApprovalStore $store,
        private readonly CmsAdapter $cms,
        public readonly Profile $profile,
        private readonly \Closure $clock,
        private readonly int $ttlSeconds = 86400,
        private readonly ?Notifier $notifier = null,
    ) {
    }

    public static function create(ApprovalStore $store, CmsAdapter $cms, Profile $profile, int $ttlSeconds = 86400, ?Notifier $notifier = null): self
    {
        return new self($store, $cms, $profile, static fn (): float => microtime(true), $ttlSeconds, $notifier);
    }

    /** What the manifest says about notifications; null when there is no notifier. @return array{decision:bool,signed:bool}|null */
    public function notifications(): ?array
    {
        return $this->notifier === null ? null : ['decision' => true, 'signed' => $this->notifier->signed()];
    }

    /** After the decision is stored. A notifier that fails must not matter here. */
    private function announce(Row $row): void
    {
        try {
            $this->notifier?->decided($row);
        } catch (\Throwable) {
            // a broken receiver or a bug in the notifier never undoes a decision
        }
    }

    public function now(): float
    {
        return ($this->clock)();
    }

    private function iso(): string
    {
        return Time::iso($this->now());
    }

    private function expireIfDue(?Row $row): ?Row
    {
        if ($row === null || !in_array($row->status, Status::EXPIRABLE, true) || !Guard::isExpired($row, $this->now())) {
            return $row;
        }
        return $this->store->transition($row->approvalId, $row->status, ['status' => Status::EXPIRED, 'decidedUtc' => $this->iso()])
            ?? $this->store->get($row->approvalId);
    }

    public function get(int $id): Row
    {
        return $this->expireIfDue($this->store->get($id)) ?? throw ApprovalException::of('NOT_FOUND', 'No proposal with that id.');
    }

    public function submit(mixed $body): Row
    {
        $input = Validation::submission($body, $this->profile);
        if ($input['revisionOfApprovalId'] !== null) {
            $parent = $this->store->get($input['revisionOfApprovalId'])
                ?? throw ApprovalException::of('NOT_FOUND', 'Parent proposal does not exist.');
            if ($parent->status !== Status::CHANGES_REQUESTED) {
                throw ApprovalException::of('REVISION_NOT_REQUESTED', 'Parent is not waiting for a revision.');
            }
            Validation::assertRevisionMatches($parent, $input);
        }
        return $this->store->insert($input + [
            'status' => Status::PENDING, 'createdUtc' => $this->iso(), 'expiresUtc' => Time::iso($this->now() + $this->ttlSeconds),
        ]);
    }

    /** @return list<Row> */
    public function list(string $kind): array
    {
        $wanted = match ($kind) {
            'pending' => [Status::PENDING],
            'history' => Status::HISTORY,
            default => throw ApprovalException::of('BAD_REQUEST', 'status must be pending or history.'),
        };
        $rows = array_map(fn (Row $r) => $this->expireIfDue($r), $this->store->list());
        $rows = array_values(array_filter($rows, static fn (?Row $r) => $r !== null && in_array($r->status, $wanted, true)));
        // Newest first by instant (not by text: a store may drop the fraction), then by id so equal instants have one order.
        usort($rows, static fn (Row $a, Row $b) => Time::parse($b->decidedUtc ?? $b->createdUtc) <=> Time::parse($a->decidedUtc ?? $a->createdUtc)
            ?: $b->approvalId <=> $a->approvalId);
        return $rows;
    }

    /**
     * Human decision. $proposal is optional on approve: the reviewer's edited payload.
     * The agent then has to execute exactly the edited JSON.
     * @param array{id:string}|null $reviewer
     */
    public function decide(int $id, string $verb, ?array $reviewer, mixed $reason, bool $hasProposal, mixed $proposal): Row
    {
        $target = Status::DECISIONS[$verb] ?? throw ApprovalException::of('BAD_REQUEST', 'Unknown decision.');
        if ($reviewer === null || ($reviewer['id'] ?? '') === '') {
            throw ApprovalException::of('SCOPE_DENIED', 'Decide requires a review session.');
        }
        if ($reason !== null && !is_string($reason)) {
            throw ApprovalException::of('BAD_REQUEST', 'reason must be a string.');
        }
        if (is_string($reason) && Json::utf16Length($reason) > $this->profile->maxReasonChars) {
            throw ApprovalException::of('BAD_REQUEST', 'reason is too long.');
        }
        $row = $this->get($id);
        if ($row->status !== Status::PENDING) {
            throw ApprovalException::of('APPROVAL_NOT_PENDING', 'Proposal is ' . $row->status . ' and cannot be decided.');
        }
        $note = Json::trim((string) $reason);
        if ($target !== Status::APPROVED && $note === '') {
            throw ApprovalException::of('DECISION_REASON_REQUIRED', 'A reason is required.');
        }
        if ($hasProposal && $target !== Status::APPROVED) {
            throw ApprovalException::of('BAD_REQUEST', 'Only approve can carry an edited proposal.');
        }
        $patch = ['status' => $target, 'decisionReason' => $note === '' ? null : $note, 'decidedUtc' => $this->iso(), 'decidedBy' => $reviewer['id']];
        if ($hasProposal && Json::canonical($proposal) !== Json::canonical($row->proposal)) {
            Validation::assertReviewable($proposal, $this->profile, Profile::isDelete($row->action));
            $patch += ['proposal' => $proposal, 'originalProposal' => $row->proposal, 'editedProposal' => true];
        }
        $updated = $this->store->transition($row->approvalId, Status::PENDING, $patch)
            ?? throw ApprovalException::of('APPROVAL_NOT_PENDING', 'Proposal was decided by someone else.');
        $this->announce($updated);
        return $updated;
    }

    /** Bind, claim once, apply through the CMS adapter inside the claim's transaction. @return array<string,mixed> */
    public function execute(mixed $write): array
    {
        if (!$write instanceof JObject) {
            throw ApprovalException::of('BAD_REQUEST', 'Request body must be a JSON object.');
        }
        $id = $write->get('approvalId');
        if (!is_int($id) && !(is_float($id) && $id === floor($id) && abs($id) < 9.2e18)) {
            throw ApprovalException::of('BAD_REQUEST', 'approvalId must be an integer.');
        }
        $row = $this->get((int) $id);
        Guard::assertBound($row, $write, $this->now());

        try {
            [$claimed, $result] = $this->store->consume($row->approvalId, $this->iso(), fn (Row $claimed) => $this->cms->apply($claimed));
        } catch (ApprovalException $e) {
            throw $e;
        } catch (\Throwable $e) {
            throw ApprovalException::of('WRITE_FAILED', 'The CMS rejected the write: ' . $e->getMessage());
        }
        if ($claimed === null) {
            throw ApprovalException::of('APPROVAL_NOT_USABLE', 'Approval was already used.');
        }
        return [
            'auditId' => $row->approvalId, 'status' => Status::CONSUMED, 'resourceType' => $row->resourceType,
            'resourceId' => $row->resourceId, 'action' => $row->action, 'result' => $result,
        ];
    }

    /** Direct read of CMS content. Reads change nothing, so they skip the queue. */
    public function readResource(int $siteId, string $resourceType, int|float|string $resourceId): JObject
    {
        return $this->cms->read($siteId, $resourceType, $resourceId) ?? throw ApprovalException::of('NOT_FOUND', 'No such resource.');
    }
}
