/**
 * Route table: method + path pattern -> door check -> service call.
 * `door(who)` runs first and throws 401/403, BEFORE the path segments are decoded or the body is read (docs/spec.md,
 * "Order of checks"); `handle` gets { req, params, query, body, who } and returns data for the envelope.
 */
import { fail } from '../core/errors.mjs';
import { LIFECYCLE } from '../core/status.mjs';

function needRead(who) {
  if (!who.agent.read && !who.reviewer) fail('UNAUTHORIZED', 'Read key or review session required.');
}
function needWrite(who, what) {
  if (!who.agent.write) fail('SCOPE_DENIED', what + ' requires the write key.');
}
function needReviewer(who) {
  if (who.agent.write) fail('SCOPE_DENIED', 'The write key cannot approve.');
  if (!who.reviewer) fail('SCOPE_DENIED', 'Decide requires a review session.');
}

/** A path segment that is a canonical integer is that number; anything else (007, +5, 4.0, abc) is a string. */
function pathId(segment) {
  return /^(0|-?[1-9]\d{0,14})$/.test(segment) ? Number(segment) : segment;
}

export function buildRoutes({ service, profile, basePath, clock = () => Date.now() }) {
  return [
    {
      method: 'GET', path: /^\/ping$/,
      handle: () => ({ ok: true, utc: new Date(clock()).toISOString() })
    },
    {
      method: 'GET', path: /^\/manifest$/, door: needRead,
      handle: () => {
        return {
          version: '2.0',
          baseUrl: basePath,
          authHeader: 'X-Api-Key',
          actions: profile.actions,
          scopes: profile.scopes,
          approvalLifecycle: LIFECYCLE,
          limits: profile.limits,
          ...(service.notifications ? { notifications: service.notifications } : {})
        };
      }
    },
    {
      method: 'GET', path: /^\/resources\/([^/]+)\/([^/]+)$/, door: needRead,
      handle: ({ params, query }) => {
        const rawSite = query.get('siteId');
        if (rawSite !== null && !/^[1-9]\d{0,8}$/.test(rawSite)) fail('BAD_REQUEST', 'siteId must be a positive integer.');
        const siteId = rawSite === null ? 1 : Number(rawSite);
        return service.readResource({ siteId, resourceType: params[0], resourceId: pathId(params[1]) });
      }
    },
    {
      method: 'GET', path: /^\/proposals$/, door: (who) => { if (!who.reviewer) fail('SCOPE_DENIED', 'Listing is a review-door call.'); },
      handle: ({ query }) => {
        return service.list((query.get('status') || 'pending').replace(/[A-Z]/g, (c) => c.toLowerCase())); // ASCII only: İ must not become i
      }
    },
    {
      method: 'GET', path: /^\/proposals\/(\d+)$/, door: needRead,
      handle: ({ params }) => service.get(params[0])
    },
    {
      method: 'POST', path: /^\/proposals$/, body: true, door: (who) => needWrite(who, 'Submit'),
      handle: ({ body }) => service.submit(body)
    },
    {
      method: 'POST', path: /^\/proposals\/(\d+)\/(approve|reject|request-changes)$/, body: true, door: needReviewer,
      handle: ({ who, params, body }) => {
        return service.decide(params[0], params[1], { reviewer: who.reviewer, reason: body.reason, proposal: body.proposal });
      }
    },
    {
      method: 'POST', path: /^\/writes$/, body: true, door: (who) => needWrite(who, 'Writes'),
      handle: ({ body }) => service.execute(body)
    }
  ];
}
