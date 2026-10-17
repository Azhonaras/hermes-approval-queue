/**
 * The write-path guard. Approval is a capability for one exact request:
 * same resource, action, scope and canonical JSON, redeemable once.
 */
import { fail } from './errors.mjs';
import { STATUS } from './status.mjs';
import { sameJson } from './canonical.mjs';
import { utcMillis } from './time.mjs';

/** Every row has an expiry; a missing or unreadable one is a store bug and throws (never "does not expire"). */
export function isExpired(row, now) {
  return utcMillis(row.expiresUtc, 'expiresUtc') < now;
}

/** Throws the documented 409 when the write does not match an Approved row. */
export function assertBound(row, write, now) {
  if (row.status === STATUS.Pending) fail('APPROVAL_PENDING', 'Not approved yet.');
  if (row.status === STATUS.Expired) fail('APPROVAL_EXPIRED', 'Approval expired.');
  if (row.status !== STATUS.Approved) fail('APPROVAL_NOT_USABLE', 'Proposal is ' + row.status + '.');
  if (isExpired(row, now)) fail('APPROVAL_EXPIRED', 'Approval expired.');

  const siteMatches = write.siteId === undefined || write.siteId === row.siteId;
  if (!siteMatches || row.resourceType !== write.resourceType || row.resourceId !== write.resourceId
    || row.action !== write.action || row.scope !== write.scope) {
    fail('APPROVAL_MISMATCH', 'Resource, action, or scope does not match.');
  }
  if (!sameJson(row.proposal, write.proposal ?? {})) {
    fail('APPROVAL_PAYLOAD_MISMATCH', 'Body does not match the approved JSON.');
  }
}
