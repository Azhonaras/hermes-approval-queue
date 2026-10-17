/**
 * In-memory approval store. A real CMS replaces this with its database,
 * keeping the same four methods. `transition` must be a conditional update
 * (UPDATE ... WHERE id = ? AND status = ?) so two writers cannot both win.
 *
 * Every method is async so a SQL or document store drops in unchanged.
 */
export function createMemoryStore({ rows = [], nextId = 1 } = {}) {
  const byId = new Map(rows.map((r) => [r.approvalId, structuredClone(r)]));
  let next = Math.max(nextId, ...[...byId.keys()].map((id) => id + 1));

  return {
    async insert(fields) {
      const row = { ...structuredClone(fields), approvalId: next++ };
      byId.set(row.approvalId, row);
      return structuredClone(row);
    },

    async get(id) {
      const row = byId.get(id);
      return row ? structuredClone(row) : null;
    },

    async list() {
      return [...byId.values()].map((r) => structuredClone(r));
    },

    /** Applies `patch` only if the row is still in `fromStatus`. Returns the new row or null. */
    async transition(id, fromStatus, patch) {
      const row = byId.get(id);
      if (!row || row.status !== fromStatus) return null;
      Object.assign(row, structuredClone(patch));
      return structuredClone(row);
    }
  };
}
