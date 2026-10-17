/**
 * A profile is the CMS-specific vocabulary: which actions and scopes exist,
 * and how large a proposal may be before a human cannot review it.
 * The protocol does not care what the verbs are, only that each one maps to one write path.
 */
export const DEFAULT_LIMITS = Object.freeze({
  maxFields: 40,
  maxJsonChars: 16384,
  maxReasonChars: 1024
});

export function createProfile({ actions, scopes, resourceTypes = null, limits = {} } = {}) {
  if (!Array.isArray(actions) || !actions.length) throw new TypeError('profile.actions must be a non-empty array');
  if (!Array.isArray(scopes) || !scopes.length) throw new TypeError('profile.scopes must be a non-empty array');
  const vague = actions.filter((a) => !/^[a-z]+:[a-z0-9._-]+$/i.test(a));
  if (vague.length) throw new TypeError('actions must look like verb:target, got ' + vague.join(', '));
  return Object.freeze({
    actions: Object.freeze([...actions]),
    scopes: Object.freeze([...scopes]),
    resourceTypes: resourceTypes ? Object.freeze([...resourceTypes]) : null,
    limits: Object.freeze({ ...DEFAULT_LIMITS, ...limits })
  });
}

export function isDeleteAction(action) {
  return String(action).startsWith('delete:');
}

/** Example SEO profile used by the demo CMS. */
export const SEO_PROFILE = createProfile({
  actions: [
    'update:onpage', 'update:canonical', 'update:redirect', 'update:schema',
    'update:indexing', 'update:contentlinks',
    'create:taxonomy', 'update:taxonomy', 'delete:taxonomy', 'merge:taxonomy'
  ],
  scopes: ['seo:write', 'content:update', 'schema:manage']
});
