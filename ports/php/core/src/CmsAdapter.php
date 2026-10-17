<?php
declare(strict_types=1);

namespace Hermes\Approval;

/**
 * The only code that touches your content. Implement both methods on top of your existing save code.
 * Throw from apply() to fail the write; the approval returns to Approved.
 * Dispatch on the action to exactly one write path.
 */
interface CmsAdapter
{
    /** The fields of one resource as an array shaped for JSON, or null when it does not exist. */
    public function read(int $siteId, string $resourceType, int|float|string $resourceId): JObject|null;

    /** Runs inside the store's transaction, so the content change and the approval claim commit (or roll back) together. */
    public function apply(Row $row): mixed;
}
