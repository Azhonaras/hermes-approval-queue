/**
 * Mountable HTTP handler: (req, res, next?) works with node:http, Express and Connect.
 * Requests outside `basePath` fall through to `next()` (or return false without one).
 */
import { ApprovalError } from '../core/errors.mjs';
import { readJson } from './body.mjs';
import { ok, error, corsHeaders } from './respond.mjs';
import { buildRoutes } from './routes.mjs';

export function createHttpHandler({ service, profile, doors, basePath = '/api/approvals', cors = null, clock, logger = console }) {
  if (!doors || typeof doors.agent !== 'function' || typeof doors.reviewer !== 'function') {
    throw new TypeError('doors.agent and doors.reviewer must be functions');
  }
  const base = basePath.replace(/\/$/, '');
  const routes = buildRoutes({ service, profile, basePath: base, clock });

  return async function approvalHandler(req, res, next) {
    // Route on the request target exactly as sent. new URL() would "normalize" it first (it resolves "/a/../b", "%2e%2e" and
    // turns "\" into "/"), so a path a front proxy or WAF rule did not recognise could still reach a route here, and the
    // other stacks answer 404 for the same bytes.
    const target = req.originalUrl || req.url;
    const cut = target.indexOf('?');
    const rawPath = cut === -1 ? target : target.slice(0, cut);
    const query = new URLSearchParams(cut === -1 ? '' : target.slice(cut + 1));
    if (rawPath !== base && !rawPath.startsWith(base + '/')) {
      if (typeof next === 'function') return next();
      return false;
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204, corsHeaders(cors));
      res.end();
      return true;
    }

    const path = rawPath.slice(base.length) || '/';
    try {
      // NUL is valid UTF-8, but some servers (Kestrel, IIS) refuse %00 before the application runs, so the contract says 400.
      if (path.includes('%00')) throw new ApprovalError('BAD_REQUEST', 'A path may not contain a NUL character.');
      const sameMethod = routes.filter((r) => r.method === req.method);
      const route = sameMethod.find((r) => r.path.test(path));
      if (!route) throw new ApprovalError('NOT_FOUND', 'No such route.');
      // Order of checks (docs/spec.md): route, door, path segments, body, then the route's own work.
      const who = { agent: await doors.agent(req), reviewer: await doors.reviewer(req) };
      if (route.door) route.door(who);
      // Path segments are percent-decoded exactly once, after the path was split on "/".
      let params;
      try { params = path.match(route.path).slice(1).map(decodeURIComponent); } catch {
        throw new ApprovalError('BAD_REQUEST', 'Malformed percent-encoding in the path.');
      }
      const body = route.body ? await readJson(req) : undefined;
      const data = await route.handle({ req, params, query, body: body || {}, who });
      ok(res, data, cors);
    } catch (err) {
      if (err instanceof ApprovalError) {
        error(res, err.http, err.code, err.message, cors);
      } else {
        logger.error(err);
        error(res, 500, 'INTERNAL', 'Unexpected server error.', cors);
      }
    }
    return true;
  };
}
