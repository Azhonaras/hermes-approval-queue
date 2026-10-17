<?php
declare(strict_types=1);

namespace Hermes\Approval;

/** One approval as the store holds it. Times are UTC ISO-8601 strings ending in Z ("Y-m-d\TH:i:s.v\Z", fraction optional); they map to the DTO untouched and are compared as instants with Time::parse. */
final class Row
{
    public function __construct(
        public int $approvalId,
        public int $siteId,
        public string $resourceType,
        public int|float|string $resourceId,
        public string $action,
        public string $scope,
        public string $status,
        public string $reason,
        public JObject $proposal,
        public ?JObject $originalProposal,
        public bool $editedProposal,
        public ?string $decisionReason,
        public ?int $revisionOfApprovalId,
        public string $createdUtc,
        public ?string $decidedUtc,
        public ?string $decidedBy,
        public string $expiresUtc,
    ) {
    }

    /** The DTO from docs/spec.md. */
    public function toDto(): array
    {
        return [
            'approvalId' => $this->approvalId, 'siteId' => $this->siteId, 'resourceType' => $this->resourceType,
            'resourceId' => $this->resourceId, 'action' => $this->action, 'scope' => $this->scope, 'status' => $this->status,
            'reason' => $this->reason, 'proposal' => $this->proposal, 'decisionReason' => $this->decisionReason,
            'revisionOfApprovalId' => $this->revisionOfApprovalId, 'createdUtc' => $this->createdUtc, 'decidedUtc' => $this->decidedUtc,
            'decidedBy' => $this->decidedBy, 'expiresUtc' => $this->expiresUtc, 'editedProposal' => $this->editedProposal,
            'originalProposal' => $this->originalProposal,
        ];
    }
}
