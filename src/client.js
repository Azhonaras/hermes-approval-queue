/**
 * Public CMS-approval client. Browser and Node 18+.
 * Point baseUrl at any CMS that implements docs/spec.md (or the demo CMS).
 * Agent uses write/read keys. Review UI uses a session header.
 * The write key cannot approve.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CmsApproval = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  var ACTIONS = [
    'update:onpage', 'update:canonical', 'update:redirect', 'update:schema',
    'update:indexing', 'update:contentlinks',
    'create:taxonomy', 'update:taxonomy', 'delete:taxonomy', 'merge:taxonomy'
  ];

  function request(baseUrl, headers, method, path, body) {
    var opts = { method: method, headers: Object.assign({ Accept: 'application/json' }, headers) };
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    return fetch(baseUrl.replace(/\/$/, '') + path, opts).then(function (res) {
      return res.json().then(function (json) {
        return { http: res.status, json: json };
      }, function () {
        return { http: res.status, json: null };
      });
    });
  }

  function unwrap(result) {
    if (result.json && result.json.success) return result.json.data;
    var err = new Error((result.json && result.json.error && result.json.error.message) || 'Request failed');
    err.code = result.json && result.json.error && result.json.error.code;
    err.http = result.http;
    throw err;
  }

  function createAgentClient(options) {
    var baseUrl = options.baseUrl;
    var headers = { 'X-Api-Key': options.writeKey || options.readKey };
    var call = request.bind(null, baseUrl, headers);
    var agent = {
      ping: function () { return call('GET', '/ping').then(unwrap); },
      manifest: function () { return call('GET', '/manifest').then(unwrap); },
      submit: function (proposal) { return call('POST', '/proposals', proposal).then(unwrap); },
      get: function (id) { return call('GET', '/proposals/' + id).then(unwrap); },
      readResource: function (type, id, siteId) {
        var q = siteId ? '?siteId=' + encodeURIComponent(siteId) : '';
        return call('GET', '/resources/' + encodeURIComponent(type) + '/' + encodeURIComponent(id) + q).then(unwrap);
      },
      execute: function (write) { return call('POST', '/writes', write).then(unwrap); },
      /**
       * Resolves with the row as soon as it is no longer Pending. A row that was decided before the first look counts as
       * decided: the first read is the answer, so a decision made while the agent was away is never missed.
       * options: { intervalMs = 2000, timeoutMs = 600000 }. Rejects with code WAIT_TIMEOUT when still Pending.
       */
      waitForDecision: function (id, options) {
        var interval = (options && options.intervalMs) || 2000;
        var deadline = Date.now() + ((options && options.timeoutMs) || 600000);
        function look() {
          return agent.get(id).then(function (row) {
            if (row.status !== 'Pending') return row;
            if (Date.now() >= deadline) {
              var err = new Error('Proposal ' + id + ' is still Pending.');
              err.code = 'WAIT_TIMEOUT';
              throw err;
            }
            return new Promise(function (resolve) { setTimeout(resolve, interval); }).then(look);
          });
        }
        return look();
      }
    };
    return agent;
  }

  /**
   * options.session: the demo's X-Review-Session value, or
   * options.headers: your CMS's own reviewer auth for a page inside the CMS (WordPress: { 'X-WP-Nonce': nonce };
   * the login cookie goes along by itself on a same-origin page). Never the agent's key.
   */
  function createReviewClient(options) {
    var baseUrl = options.baseUrl;
    var headers = options.headers ? Object.assign({}, options.headers)
      : options.session ? { 'X-Review-Session': options.session } : null;
    if (!headers) throw new Error('Review client needs a session or CMS auth headers. Do not reuse the write key.');
    if (Object.keys(headers).some(function (h) { return h.toLowerCase() === 'x-api-key'; })) {
      throw new Error('Review client must not carry an agent key.');
    }
    var call = request.bind(null, baseUrl, headers);
    return {
      manifest: function () { return call('GET', '/manifest').then(unwrap); },
      readResource: function (type, id, siteId) {
        var q = siteId ? '?siteId=' + encodeURIComponent(siteId) : '';
        return call('GET', '/resources/' + encodeURIComponent(type) + '/' + encodeURIComponent(id) + q).then(unwrap);
      },
      listPending: function () { return call('GET', '/proposals?status=pending').then(unwrap); },
      listHistory: function () { return call('GET', '/proposals?status=history').then(unwrap); },
      // Pass editedProposal to approve the reviewer's version instead of the agent's.
      approve: function (id, reason, editedProposal) {
        var body = { reason: reason || '' };
        if (editedProposal !== undefined) body.proposal = editedProposal;
        return call('POST', '/proposals/' + id + '/approve', body).then(unwrap);
      },
      reject: function (id, reason) {
        return call('POST', '/proposals/' + id + '/reject', { reason: reason }).then(unwrap);
      },
      requestChanges: function (id, reason) {
        return call('POST', '/proposals/' + id + '/request-changes', { reason: reason }).then(unwrap);
      }
    };
  }

  return {
    ACTIONS: ACTIONS,
    createAgentClient: createAgentClient,
    createReviewClient: createReviewClient
  };
});
