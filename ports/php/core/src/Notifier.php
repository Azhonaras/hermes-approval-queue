<?php
declare(strict_types=1);

namespace Hermes\Approval;

/**
 * Decision notifications (docs/spec.md, "Decision notifications"): tells the agent that a person has decided.
 * Optional. The service calls decided() once after a decision has been stored, and never lets it undo, delay or fail
 * that decision, so a notifier may throw; but it should return quickly (queue the delivery, send it after the response).
 */
interface Notifier
{
    /** A stored approve, reject or request-changes. Not called for a submit, a write, an expiry or a refused decision. */
    public function decided(Row $row): void;

    /** Whether deliveries carry X-Hermes-Timestamp and X-Hermes-Signature; the manifest says so. */
    public function signed(): bool;
}
