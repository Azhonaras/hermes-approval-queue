/**
 * Application service: every use case of the approval queue, independent of HTTP.
 * Dependencies are injected so each can be swapped (store, CMS, clock).
 */
import { fail } from './errors.mjs';
import { STATUS, HISTORY, EXPIRABLE, DECISIONS } from './status.mjs';
import { validateSubmission, assertRevisionMatches, assertReviewable } from './validate.mjs';
import { assertBound, isExpired } from './guard.mjs';
import { utcMillis } from './time.mjs';
import { sameJson } from './canonical.mjs';
import { assertCmsAdapter } from '../cms/adapter.mjs';

const DAY_MS = 24 * 3600 * 1000;

/**
 * `notifier` is optional: { decided(row), signed? }. It is told about every stored decision (docs/spec.md, "Decision
 * notifications") and can never undo, delay or fail one.
 */
export function createApprovalService({ store, cms, profile, clock = () => Date.now(), ttlMs = DAY_MS, notifier = null }) {
  assertCmsAdapter(cms);
  const iso = () => new Date(clock()).toISOString();

  /** Fire and forget, after the decision is stored. A receiver that is down, slow or broken must not matter here. */
  function announce(row) {
    if (!notifier) return;
    try { Promise.resolve(notifier.decided(row)).catch(() => {}); } catch { /* a faulty notifier must not undo a decision */ }
  }

  async function expireIfDue(row) {
    if (!row || !EXPIRABLE.includes(row.status) || !isExpired(row, clock())) return row;
    return (await store.transition(row.approvalId, row.status, { status: STATUS.Expired, decidedUtc: iso() })) || store.get(row.approvalId);
  }

  async function load(id) {
    const row = await expireIfDue(await store.get(Number(id)));
    if (!row) fail('NOT_FOUND', 'No proposal with that id.');
    return row;
  }

  async function submit(body) {
    const input = validateSubmission(body, profile);
    if (input.revisionOfApprovalId) {
      const parent = await store.get(input.revisionOfApprovalId);
      if (!parent) fail('NOT_FOUND', 'Parent proposal does not exist.');
      if (parent.status !== STATUS.ChangesRequested) {
        fail('REVISION_NOT_REQUESTED', 'Parent is not waiting for a revision.');
      }
      assertRevisionMatches(parent, input);
    }
    return store.insert({
      ...input,
      status: STATUS.Pending,
      decisionReason: null,
      createdUtc: iso(),
      decidedUtc: null,
      decidedBy: null,
      expiresUtc: new Date(clock() + ttlMs).toISOString(),
      editedProposal: false,
      originalProposal: null
    });
  }

  async function list(kind) {
    const wanted = kind === 'pending' ? [STATUS.Pending] : kind === 'history' ? HISTORY : null;
    if (!wanted) fail('BAD_REQUEST', 'status must be pending or history.');
    const rows = await Promise.all((await store.list()).map(expireIfDue));
    return rows
      .filter((r) => wanted.includes(r.status))
      .sort((a, b) => utcMillis(b.decidedUtc || b.createdUtc) - utcMillis(a.decidedUtc || a.createdUtc) || b.approvalId - a.approvalId);
  }

  /**
   * Human decision. `proposal` is optional on approve: the reviewer's edited payload.
   * The agent then has to execute exactly the edited JSON.
   */
  async function decide(id, verb, { reviewer, reason = '', proposal } = {}) {
    const target = DECISIONS[verb];
    if (!target) fail('BAD_REQUEST', 'Unknown decision.');
    if (!reviewer || !reviewer.id) fail('SCOPE_DENIED', 'Decide requires a review session.');
    if (reason !== undefined && reason !== null && typeof reason !== 'string') fail('BAD_REQUEST', 'reason must be a string.');
    if (reason && reason.length > profile.limits.maxReasonChars) fail('BAD_REQUEST', 'reason is too long.');
    const row = await load(id);
    if (row.status !== STATUS.Pending) {
      fail('APPROVAL_NOT_PENDING', 'Proposal is ' + row.status + ' and cannot be decided.');
    }
    const note = (reason || '').trim();
    if (target !== STATUS.Approved && !note) fail('DECISION_REASON_REQUIRED', 'A reason is required.');
    if (proposal !== undefined && target !== STATUS.Approved) {
      fail('BAD_REQUEST', 'Only approve can carry an edited proposal.');
    }

    const patch = { status: target, decisionReason: note || null, decidedUtc: iso(), decidedBy: reviewer.id };
    if (proposal !== undefined && !sameJson(proposal, row.proposal)) {
      assertReviewable(proposal, profile, { allowEmpty: row.action.startsWith('delete:') });
      Object.assign(patch, { proposal, originalProposal: row.proposal, editedProposal: true });
    }
    const updated = await store.transition(row.approvalId, STATUS.Pending, patch);
    if (!updated) fail('APPROVAL_NOT_PENDING', 'Proposal was decided by someone else.');
    announce(updated);
    return updated;
  }

  /** Bind, claim once, apply through the CMS adapter, roll back the claim if the CMS fails. */
  async function execute(write) {
    if (!write || typeof write !== 'object' || Array.isArray(write)) fail('BAD_REQUEST', 'Request body must be a JSON object.');
    if (!Number.isInteger(write.approvalId)) fail('BAD_REQUEST', 'approvalId must be an integer.');
    const row = await load(write.approvalId);
    assertBound(row, write, clock());

    const claimed = await store.transition(row.approvalId, STATUS.Approved, { status: STATUS.Consumed, consumedUtc: iso() });
    if (!claimed) fail('APPROVAL_NOT_USABLE', 'Approval was already used.');

    let result;
    try {
      result = await cms.apply({
        approvalId: row.approvalId,
        siteId: row.siteId,
        resourceType: row.resourceType,
        resourceId: row.resourceId,
        action: row.action,
        proposal: row.proposal
      });
    } catch (err) {
      await store.transition(row.approvalId, STATUS.Consumed, { status: STATUS.Approved, consumedUtc: null });
      fail('WRITE_FAILED', 'The CMS rejected the write: ' + (err && err.message ? err.message : 'unknown error'));
    }
    return {
      auditId: row.approvalId,
      status: STATUS.Consumed,
      resourceType: row.resourceType,
      resourceId: row.resourceId,
      action: row.action,
      result: result ?? null
    };
  }

  /** Direct read of CMS content. Reads change nothing, so they skip the queue. */
  async function readResource({ siteId = 1, resourceType, resourceId }) {
    const found = await cms.read({ siteId, resourceType, resourceId });
    if (found == null) fail('NOT_FOUND', 'No such resource.');
    return found;
  }

  /** What the manifest says about notifications; null when there is no notifier. */
  const notifications = notifier ? { decision: true, signed: Boolean(notifier.signed) } : null;

  return { submit, get: load, list, decide, execute, readResource, notifications };
}
