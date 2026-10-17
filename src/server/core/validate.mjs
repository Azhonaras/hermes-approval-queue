/**
 * Pure checks on what the agent submits and what a reviewer edits.
 * No I/O, so the rules can be tested without a server or a database.
 */
import { fail } from './errors.mjs';
import { isDeleteAction } from './profile.mjs';

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Field-count and size caps: a human must be able to read the payload. */
export function assertReviewable(proposal, profile, { allowEmpty = false } = {}) {
  if (!isPlainObject(proposal)) fail('BAD_REQUEST', 'proposal must be a JSON object.');
  const fields = Object.keys(proposal).length;
  if (!fields && !allowEmpty) fail('BAD_REQUEST', 'proposal is required.');
  if (fields > profile.limits.maxFields) fail('BAD_REQUEST', 'Too many proposal fields.');
  if (JSON.stringify(proposal).length > profile.limits.maxJsonChars) {
    fail('BAD_REQUEST', 'Proposal is too large to review.');
  }
  return proposal;
}

/** Returns the normalized submission or throws BAD_REQUEST. */
const isInt = (v) => typeof v === 'number' && Number.isInteger(v);
/** The same rule as the siteId query parameter: a positive integer of at most nine digits. */
const isSiteId = (v) => isInt(v) && v >= 1 && v <= 999999999;

/** A resource id is a string or a number. Objects, arrays and booleans are refused. */
export function assertResourceId(value) {
  const present = value !== null && value !== undefined && value !== '';
  if (!present) fail('BAD_REQUEST', 'resourceType and resourceId are required.');
  if (typeof value !== 'string' && typeof value !== 'number') fail('BAD_REQUEST', 'resourceId must be a string or a number.');
  if (JSON.stringify(value).length > MAX_RESOURCE_ID_CHARS) fail('BAD_REQUEST', 'resourceId is too long.');
}

/** Identifier columns in every store are this wide; longer values are refused up front instead of failing in the database. */
export const MAX_RESOURCE_TYPE_CHARS = 100;
export const MAX_RESOURCE_ID_CHARS = 200;

export function validateSubmission(body, profile) {
  if (!isPlainObject(body)) fail('BAD_REQUEST', 'Request body must be a JSON object.');

  const resourceType = typeof body.resourceType === 'string' ? body.resourceType.trim() : '';
  if (!resourceType) fail('BAD_REQUEST', 'resourceType and resourceId are required.');
  if (resourceType.length > MAX_RESOURCE_TYPE_CHARS) fail('BAD_REQUEST', 'resourceType is too long.');
  assertResourceId(body.resourceId);
  if (body.siteId !== undefined && !isSiteId(body.siteId)) fail('BAD_REQUEST', 'siteId must be an integer from 1 to 999999999.');
  if (body.reason !== undefined && body.reason !== null && typeof body.reason !== 'string') fail('BAD_REQUEST', 'reason must be a string.');
  if (body.revisionOfApprovalId !== undefined && body.revisionOfApprovalId !== null && !isInt(body.revisionOfApprovalId)) {
    fail('BAD_REQUEST', 'revisionOfApprovalId must be an integer.');
  }
  if (typeof body.action !== 'string' || typeof body.scope !== 'string') fail('BAD_REQUEST', 'action and scope must be strings.');
  if (profile.resourceTypes && !profile.resourceTypes.includes(resourceType)) {
    fail('BAD_REQUEST', 'Unknown resourceType.');
  }

  const action = String(body.action || '');
  const scope = String(body.scope || '');
  if (!profile.actions.includes(action)) fail('BAD_REQUEST', 'Unknown action.');
  if (!profile.scopes.includes(scope)) fail('BAD_REQUEST', 'Unknown scope.');

  const proposal = assertReviewable(body.proposal, profile, { allowEmpty: isDeleteAction(action) });

  const reason = body.reason == null ? '' : String(body.reason);
  if (reason.length > profile.limits.maxReasonChars) fail('BAD_REQUEST', 'reason is too long.');

  return {
    siteId: body.siteId ?? 1,
    resourceType,
    resourceId: body.resourceId,
    action,
    scope,
    reason,
    proposal,
    revisionOfApprovalId: body.revisionOfApprovalId ? Number(body.revisionOfApprovalId) : null
  };
}

/** A revision may change reason and proposal only. */
export function assertRevisionMatches(parent, submission) {
  if (parent.siteId !== submission.siteId || parent.resourceType !== submission.resourceType
    || parent.resourceId !== submission.resourceId || parent.action !== submission.action
    || parent.scope !== submission.scope) {
    fail('REVISION_MISMATCH', 'Revision must keep the parent site, resource, action, and scope.');
  }
}
