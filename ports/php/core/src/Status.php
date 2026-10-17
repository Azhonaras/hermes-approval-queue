<?php
declare(strict_types=1);

namespace Hermes\Approval;

final class Status
{
    public const PENDING = 'Pending', APPROVED = 'Approved', REJECTED = 'Rejected',
        CHANGES_REQUESTED = 'ChangesRequested', CONSUMED = 'Consumed', EXPIRED = 'Expired';

    public const LIFECYCLE = [self::PENDING, self::APPROVED, self::REJECTED, self::CHANGES_REQUESTED, self::CONSUMED, self::EXPIRED];
    /** History keeps Approved visible until the agent consumes it. */
    public const HISTORY = [self::APPROVED, self::REJECTED, self::CONSUMED, self::CHANGES_REQUESTED, self::EXPIRED];
    public const EXPIRABLE = [self::PENDING, self::APPROVED];
    public const DECISIONS = ['approve' => self::APPROVED, 'reject' => self::REJECTED, 'request-changes' => self::CHANGES_REQUESTED];
}
