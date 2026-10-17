/**
 * Public entry for Node CMSs. Wire four pieces and mount the handler:
 *
 *   const service = createApprovalService({ store, cms, profile });          // + notifier: createWebhookNotifier({ url, secret }) to tell the agent
 *   app.use(createHttpHandler({ service, profile, doors, basePath: '/api/approvals' }));
 *
 * Non-Node CMSs implement docs/spec.md directly; these modules are the reference.
 */
export { createApprovalService } from './core/approval-service.mjs';
export { createProfile, SEO_PROFILE, DEFAULT_LIMITS } from './core/profile.mjs';
export { ApprovalError, ERROR_HTTP } from './core/errors.mjs';
export { STATUS, LIFECYCLE } from './core/status.mjs';
export { canonical, sameJson } from './core/canonical.mjs';
export { assertBound } from './core/guard.mjs';
export { createMemoryStore } from './store/memory-store.mjs';
export { createMemoryCms } from './cms/memory-cms.mjs';
export { assertCmsAdapter } from './cms/adapter.mjs';
export { createWebhookNotifier, decisionBody, signDelivery } from './notify/webhook.mjs';
export { createHttpHandler } from './http/create-handler.mjs';
export { apiKeyAgentDoor, headerReviewerDoor } from './http/doors.mjs';
