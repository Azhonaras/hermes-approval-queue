<?php
declare(strict_types=1);

namespace Hermes\Approval;

/** The write-path guard. Approval is a capability for one exact request: same resource, action, scope and canonical JSON, redeemable once. */
final class Guard
{
    public static function isExpired(Row $row, float $now): bool
    {
        return Time::parse($row->expiresUtc) < $now; // an unreadable or empty expiry throws: it must never mean "never expires"
    }

    /** Throws the documented 409 when the write does not match an Approved row. */
    public static function assertBound(Row $row, JObject $write, float $now): void
    {
        match ($row->status) {
            Status::PENDING => throw ApprovalException::of('APPROVAL_PENDING', 'Not approved yet.'),
            Status::EXPIRED => throw ApprovalException::of('APPROVAL_EXPIRED', 'Approval expired.'),
            Status::APPROVED => null,
            default => throw ApprovalException::of('APPROVAL_NOT_USABLE', 'Proposal is ' . $row->status . '.'),
        };
        if (self::isExpired($row, $now)) {
            throw ApprovalException::of('APPROVAL_EXPIRED', 'Approval expired.');
        }
        $site = $write->get('siteId');
        $siteMatches = !$write->has('siteId') || ((is_int($site) || is_float($site)) && $site == $row->siteId);
        $sameId = $write->has('resourceId') && Json::canonical($write->get('resourceId')) === Json::canonical($row->resourceId);
        if (!$siteMatches || $write->get('resourceType') !== $row->resourceType || !$sameId
            || $write->get('action') !== $row->action || $write->get('scope') !== $row->scope) {
            throw ApprovalException::of('APPROVAL_MISMATCH', 'Resource, action, or scope does not match.');
        }
        $proposal = $write->has('proposal') && $write->get('proposal') !== null ? $write->get('proposal') : new JObject();
        if (Json::canonical($proposal) !== Json::canonical($row->proposal)) {
            throw ApprovalException::of('APPROVAL_PAYLOAD_MISMATCH', 'Body does not match the approved JSON.');
        }
    }
}
