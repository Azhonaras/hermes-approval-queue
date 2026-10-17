/**
 * Demo CMS content held in memory. Shows how an adapter maps each action
 * to one write path. Replace with calls into your real CMS.
 */
function key(siteId, resourceType, resourceId) {
  return siteId + ':' + resourceType + ':' + JSON.stringify(resourceId); // 42 and "42" are different resources
}

export function createMemoryCms({ resources = [] } = {}) {
  const content = new Map(resources.map((r) => [key(r.siteId ?? 1, r.resourceType, r.resourceId), structuredClone(r.fields)]));

  const handlers = {
    update(current, proposal) {
      // A real CMS validates what it saves. The demo refuses a canonical that is not an absolute http(s) URL.
      if (typeof proposal.canonical === 'string' && proposal.canonical !== '' && !/^https?:\/\/\S+$/.test(proposal.canonical)) {
        throw new Error('canonical must be an absolute http(s) URL');
      }
      return { ...current, ...proposal };
    },
    create(current, proposal) { return { ...proposal }; },
    merge(current, proposal) { return { ...current, mergedInto: proposal.into ?? null }; },
    delete() { return null; }
  };

  return {
    async read({ siteId = 1, resourceType, resourceId }) {
      const found = content.get(key(siteId, resourceType, resourceId));
      return found ? structuredClone(found) : null;
    },

    async apply({ siteId = 1, resourceType, resourceId, action, proposal }) {
      const verb = action.split(':')[0];
      const handler = handlers[verb];
      if (!handler) throw new Error('No write path for ' + action);
      const k = key(siteId, resourceType, resourceId);
      const next = handler(content.get(k) || {}, proposal);
      if (next === null) content.delete(k);
      else content.set(k, next);
      return { resourceType, resourceId, fields: next };
    }
  };
}
