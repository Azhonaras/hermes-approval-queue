<?php
declare(strict_types=1);

namespace Hermes\Approval\Store;

use Hermes\Approval\Row;

interface ApprovalStore
{
    /** Inserts a Pending row and returns it with its new id. @param array<string,mixed> $values */
    public function insert(array $values): Row;

    public function get(int $id): ?Row;

    /** @param list<string>|null $statuses null = every row @return list<Row> */
    public function list(?array $statuses = null): array;

    /**
     * Applies $patch only if the row is still in $from. Null when someone else got there first.
     * Patch keys: status, decisionReason, decidedUtc, decidedBy, proposal, originalProposal, editedProposal.
     * @param array<string,mixed> $patch
     */
    public function transition(int $id, string $from, array $patch): ?Row;

    /**
     * Claims an Approved row (Approved -> Consumed) and runs $apply in the SAME transaction.
     * If $apply throws, the claim is rolled back too and the row is Approved again.
     * Returns [row, result], or [null, null] when the claim lost a race.
     * @param callable(Row):mixed $apply
     * @return array{0:?Row,1:mixed}
     */
    public function consume(int $id, string $nowUtc, callable $apply): array;
}
