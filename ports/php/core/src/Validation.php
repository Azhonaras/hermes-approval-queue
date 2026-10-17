<?php
declare(strict_types=1);

namespace Hermes\Approval;

/** Pure checks on what the agent submits and what a reviewer edits. No I/O. */
final class Validation
{
    public static function assertReviewable(mixed $proposal, Profile $profile, bool $allowEmpty = false): JObject
    {
        if (!$proposal instanceof JObject) {
            throw ApprovalException::of('BAD_REQUEST', 'proposal must be a JSON object.');
        }
        if (count($proposal) === 0 && !$allowEmpty) {
            throw ApprovalException::of('BAD_REQUEST', 'proposal is required.');
        }
        if (count($proposal) > $profile->maxFields) {
            throw ApprovalException::of('BAD_REQUEST', 'Too many proposal fields.');
        }
        if (Json::compactLength($proposal) > $profile->maxJsonChars) {
            throw ApprovalException::of('BAD_REQUEST', 'Proposal is too large to review.');
        }
        return $proposal;
    }

    /** A resource id is a string or a number. Objects, arrays, booleans and over-long values are refused. */
    public static function assertResourceId(mixed $value): void
    {
        if ($value === null || $value === '') {
            throw ApprovalException::of('BAD_REQUEST', 'resourceType and resourceId are required.');
        }
        if (!is_string($value) && !is_int($value) && !is_float($value)) {
            throw ApprovalException::of('BAD_REQUEST', 'resourceId must be a string or a number.');
        }
        if (Json::utf16Length(Json::encode($value)) > Profile::MAX_RESOURCE_ID_CHARS) {
            throw ApprovalException::of('BAD_REQUEST', 'resourceId is too long.');
        }
    }

    /** Whole numbers are ints in the DTO whichever way the agent wrote them (42, 42.0, 4.2e1). */
    public static function normalizeId(int|float|string $id): int|float|string
    {
        return is_float($id) && $id === floor($id) && abs($id) < 9.2e18 ? (int) $id : $id;
    }

    /** @return array{siteId:int,resourceType:string,resourceId:int|float|string,action:string,scope:string,reason:string,proposal:JObject,revisionOfApprovalId:?int} */
    public static function submission(mixed $body, Profile $profile): array
    {
        if (!$body instanceof JObject) {
            throw ApprovalException::of('BAD_REQUEST', 'Request body must be a JSON object.');
        }
        $type = $body->get('resourceType');
        $resourceType = is_string($type) ? Json::trim($type) : '';
        if ($resourceType === '') {
            throw ApprovalException::of('BAD_REQUEST', 'resourceType and resourceId are required.');
        }
        if (Json::utf16Length($resourceType) > Profile::MAX_RESOURCE_TYPE_CHARS) {
            throw ApprovalException::of('BAD_REQUEST', 'resourceType is too long.');
        }
        $resourceId = $body->get('resourceId');
        self::assertResourceId($resourceId);

        $siteId = $body->get('siteId');
        if ($body->has('siteId') && (!(is_int($siteId) || (is_float($siteId) && $siteId === floor($siteId))) || $siteId < 1 || $siteId > 999999999)) {
            throw ApprovalException::of('BAD_REQUEST', 'siteId must be an integer from 1 to 999999999.');
        }
        $reason = $body->get('reason');
        if ($reason !== null && !is_string($reason)) {
            throw ApprovalException::of('BAD_REQUEST', 'reason must be a string.');
        }
        $rev = $body->get('revisionOfApprovalId');
        if ($rev !== null && !is_int($rev) && !(is_float($rev) && $rev === floor($rev))) {
            throw ApprovalException::of('BAD_REQUEST', 'revisionOfApprovalId must be an integer.');
        }
        $action = $body->get('action');
        $scope = $body->get('scope');
        if (!is_string($action) || !is_string($scope)) {
            throw ApprovalException::of('BAD_REQUEST', 'action and scope must be strings.');
        }
        if (!in_array($action, $profile->actions, true)) {
            throw ApprovalException::of('BAD_REQUEST', 'Unknown action.');
        }
        if (!in_array($scope, $profile->scopes, true)) {
            throw ApprovalException::of('BAD_REQUEST', 'Unknown scope.');
        }
        $proposal = self::assertReviewable($body->get('proposal'), $profile, Profile::isDelete($action));
        $reasonText = $reason ?? '';
        if (Json::utf16Length($reasonText) > $profile->maxReasonChars) {
            throw ApprovalException::of('BAD_REQUEST', 'reason is too long.');
        }
        return [
            'siteId' => $siteId === null ? 1 : (int) $siteId,
            'resourceType' => $resourceType,
            'resourceId' => self::normalizeId($resourceId),
            'action' => $action,
            'scope' => $scope,
            'reason' => $reasonText,
            'proposal' => $proposal,
            'revisionOfApprovalId' => $rev ? (int) $rev : null,
        ];
    }

    /** A revision may change reason and proposal only. */
    public static function assertRevisionMatches(Row $parent, array $s): void
    {
        if ($parent->siteId !== $s['siteId'] || $parent->resourceType !== $s['resourceType']
            || Json::canonical($parent->resourceId) !== Json::canonical($s['resourceId'])
            || $parent->action !== $s['action'] || $parent->scope !== $s['scope']) {
            throw ApprovalException::of('REVISION_MISMATCH', 'Revision must keep the parent site, resource, action, and scope.');
        }
    }
}
