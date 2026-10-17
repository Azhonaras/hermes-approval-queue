'use strict';
/**
 * A standing agent: a long-running process that acts on a person's decision the moment the CMS announces it, without
 * any chat session or separate watcher in between. Node 18+, no dependencies.
 *
 *   const { createAgentClient } = require('./client.js');
 *   const { createStandingAgent } = require('./standing-agent.js');
 *   const standing = createStandingAgent({
 *     agent: createAgentClient({ baseUrl, writeKey }),
 *     receiver: { port: 8796, secret: process.env.WEBHOOK_SECRET },
 *     stateFile: 'standing-agent.json',
 *     onOutcome: (o) => console.log(o)
 *   });
 *   await standing.start();
 *   await standing.submit({ ... });     // filed and remembered; redeemed by itself once a person approves
 *
 * What it does with a decision about a request it filed:
 *   Approved          -> redeems exactly the approved JSON the CMS returns (the reviewer's edit, if any), once
 *   Rejected / ChangesRequested -> reports it through onOutcome; nothing is written
 * A notification is only a nudge, so it always reads the row with the agent's own key, and a slow poll over the open
 * requests (and one sweep at start-up) catches decisions made while it was down or whose notification was lost.
 * Requests it did not file are ignored: a nudge never makes it write something it did not propose.
 */
const fs = require('node:fs');
const { createReceiver } = require('./receiver.js');

const MAX_ATTEMPTS = 5; // a redeem that keeps failing (for example WRITE_FAILED) is reported, then left to a person

function createStandingAgent({ agent, receiver = {}, stateFile = '', pollMs = 30000, logger = console, onOutcome = () => {}, now = () => new Date() } = {}) {
  if (!agent || typeof agent.get !== 'function' || typeof agent.execute !== 'function') throw new TypeError('agent must be a client from createAgentClient');
  const open = new Map();     // approvalId -> { attempts }
  const finished = {};        // approvalId -> final status, kept in the state file as a record
  const running = new Map();  // approvalId -> promise, so a nudge and the poll never redeem the same row twice
  let rx = null;
  let timer = null;

  function load() {
    if (!stateFile) return;
    try {
      const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      for (const id of saved.open || []) if (Number.isInteger(id)) open.set(id, { attempts: 0 });
      Object.assign(finished, saved.finished || {});
    } catch (err) {
      if (err.code !== 'ENOENT') logger.warn('[standing-agent] could not read ' + stateFile + ': ' + err.message);
    }
  }
  function save() {
    if (!stateFile) return;
    try { fs.writeFileSync(stateFile, JSON.stringify({ open: [...open.keys()], finished }, null, 2)); }
    catch (err) { logger.warn('[standing-agent] could not write ' + stateFile + ': ' + err.message); }
  }
  function report(outcome) {
    Promise.resolve().then(() => onOutcome({ ...outcome, at: now().toISOString() }))
      .catch((err) => logger.warn('[standing-agent] onOutcome failed: ' + (err && err.message ? err.message : err)));
  }
  function close(id, status, extra) {
    open.delete(id);
    finished[id] = status;
    save();
    report({ approvalId: id, status, ...extra });
  }

  async function settle(id) {
    const state = open.get(id);
    if (!state) return;
    const row = await agent.get(id);
    if (row.status === 'Pending') return; // an early nudge, or the poll looking before anyone decided
    if (row.status === 'Approved') {
      state.attempts += 1;
      try {
        const written = await agent.execute({
          approvalId: row.approvalId, resourceType: row.resourceType, resourceId: row.resourceId,
          action: row.action, scope: row.scope, proposal: row.proposal
        });
        logger.log('[standing-agent] HRM-' + id + ' approved -> executed (' + (written && written.status) + ')');
        close(id, 'Consumed', { row, written });
      } catch (err) {
        if (err.code === 'APPROVAL_EXPIRED' || err.code === 'APPROVAL_NOT_USABLE') {
          logger.warn('[standing-agent] HRM-' + id + ' can no longer be used (' + err.code + ')');
          close(id, err.code === 'APPROVAL_EXPIRED' ? 'Expired' : 'ExecutionFailed', { row, error: { code: err.code, message: err.message } });
          return;
        }
        logger.warn('[standing-agent] HRM-' + id + ' could not be executed (' + (err.code || err.message) + '), attempt ' + state.attempts);
        if (state.attempts >= MAX_ATTEMPTS) close(id, 'ExecutionFailed', { row, error: { code: err.code || null, message: err.message } });
      }
      return;
    }
    logger.log('[standing-agent] HRM-' + id + ' is ' + row.status + (row.decisionReason ? ': ' + row.decisionReason : ''));
    close(id, row.status, { row });
  }

  function settleOnce(id) {
    if (running.has(id)) return running.get(id);
    const job = settle(id)
      .catch((err) => logger.warn('[standing-agent] HRM-' + id + ': ' + (err && err.message ? err.message : err)))
      .finally(() => running.delete(id));
    running.set(id, job);
    return job;
  }
  const sweep = () => Promise.all([...open.keys()].map(settleOnce));

  return {
    /** Starts listening, then sweeps once for decisions made while this process was not running. */
    async start() {
      load();
      rx = await createReceiver({
        ...receiver,
        logger,
        onDecision: ({ approvalId, status }, { signed }) => {
          logger.log('[standing-agent] notified: HRM-' + approvalId + ' is ' + status + (signed ? ' (signature checked)' : ' (unsigned: a hint only)'));
          if (!open.has(approvalId)) { logger.log('[standing-agent] HRM-' + approvalId + ' was not filed by this agent: ignored'); return; }
          return settleOnce(approvalId);
        }
      });
      timer = setInterval(sweep, pollMs);
      if (timer.unref) timer.unref();
      await sweep();
      return { url: rx.url, port: rx.port };
    },
    /** Files a request and remembers it, so the decision is acted on without anyone asking. */
    async submit(proposal) {
      const row = await agent.submit(proposal);
      open.set(row.approvalId, { attempts: 0 });
      save();
      return row;
    },
    /** Remembers a request that was filed some other way. */
    track(id) {
      if (!Number.isInteger(id)) throw new TypeError('approval id must be an integer');
      if (!open.has(id)) { open.set(id, { attempts: 0 }); save(); }
    },
    open: () => [...open.keys()],
    finished: () => ({ ...finished }),
    /** Test and shutdown helper: look at every open request now. */
    sweep,
    async stop() {
      if (timer) clearInterval(timer);
      timer = null;
      if (rx) await rx.close();
      rx = null;
      await Promise.all([...running.values()]);
    }
  };
}

module.exports = { createStandingAgent, MAX_ATTEMPTS };
