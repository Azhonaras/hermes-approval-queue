/**
 * The CMS adapter is the only module that touches your content.
 * Implement these two functions on top of your existing save code:
 *
 *   read({ siteId, resourceType, resourceId })            -> object | null
 *   apply({ siteId, resourceType, resourceId, action, proposal, approvalId })
 *                                                         -> any (returned to the agent)
 *
 * `apply` runs only after the guard has bound and claimed an approval.
 * Throw to signal failure; the approval goes back to Approved so it can be retried.
 * Dispatch on `action` (e.g. 'update:title', 'delete:post') to exactly one write path.
 */
export function assertCmsAdapter(cms) {
  if (!cms || typeof cms.read !== 'function' || typeof cms.apply !== 'function') {
    throw new TypeError('cms adapter must implement read() and apply()');
  }
  return cms;
}
