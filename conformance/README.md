# Conformance suite

Black-box checks that tell you whether your CMS implements
[`docs/spec.md`](../docs/spec.md) correctly, whatever it is written in
(PHP, Symfony, .NET, Ruby, Node). It only speaks HTTP, so it needs nothing
from your codebase.

It answers one question: *can the agent ever change content without a human
approving exactly that change, exactly once?*

## Run it

1. Deploy your implementation to a staging copy. The suite creates,
   approves, rejects and executes real rows and rewrites one test resource.
2. Copy [`profiles/example.json`](profiles/example.json) and fill it in:
   base URL, the agent's read and write keys, a manager session (cookie and
   CSRF header if your CMS needs them), one valid action and scope, and a
   test resource.
3. Run:

```bash
node conformance/run.mjs --config conformance/profiles/my-cms.json --yes
```

Try it on the bundled demo first:

```bash
npm start                      # terminal 1
npm run conformance            # terminal 2
```

Exit code `0` means every MUST check passed, `1` means a MUST failed,
`2` means bad settings. `--json report.json` saves the full report.

## What it checks

| Group | Proves |
| --- | --- |
| `doors` | The write key, read key and "no credentials" can never approve, reject or list the queue. A review session can never submit or write. The door answers first: a caller who may not do something learns nothing about how its body, path or query would have been read. |
| `validation` | Bare `update` actions, unknown actions/scopes, empty or oversized payloads and malformed JSON are refused. Non-ASCII text is stored exactly. |
| `lifecycle` | Nothing is writable while Pending, Rejected or ChangesRequested. A row is decided once. Reasons are required. Revisions are new rows. |
| `binding` | The approved JSON runs once. A changed, extended or reduced payload, or another resource, action or scope, is a 409. Key order does not matter. Reviewer edits bind the edited JSON. |
| `edge` | Hostile and awkward input, one rule per check ([Strict input](../docs/spec.md#strict-input)): size counted in characters not escapes, duplicate keys, invalid Unicode, nesting, number rules, identifier limits, strict types, decision input, write-body type confusion, path and query rules (raw paths are routed as sent, exact parameter names), `Content-Type` (`415`), the agent key read by its header name only, trimming, `__proto__`, a battery of malformed requests that must never give a 5xx. |
| `concurrency` | Eight parallel writes of one approval: one wins. Approve vs reject at the same moment: one wins. |
| `stress` | 60 complete flows at once; 30 approvals each written by 4 clients (exactly 30 writes win); 40 rows each decided by 3 reviewers; polling stays healthy during writes. Zero 5xx allowed. |
| `effects` | With `--verify-url`, the CMS itself is read (not the approval API): unchanged before approval and after refusals, changed exactly once after a write, unchanged by a replay. With `--failing-payload` too: a save the CMS refuses is `502 WRITE_FAILED`, leaves no partial change, and the approval is `Approved` again. |
| `notify` | Optional, runs only with a `notify` setting ([below](#decision-notifications-the-notify-group)). A stored decision is announced once with exactly the four documented fields and no content; the signature verifies; nothing is announced for a submit, a refused or repeated decision or a write; a receiver that answers `500`, hangs or is down changes nothing; the reviewer does not wait for a slow receiver; redirects are not followed, failures are not retried; the manifest says so. |
| `hygiene` | No wildcard CORS, no stack traces in errors, keys never echoed. These are warnings, not failures (`--strict` makes them failures). |

`binding.reviewer-edit` is an extension. If your CMS does not support editing it
is skipped, not failed.

A web server in front of the CMS: nginx and Apache refuse a malformed percent-escape (`/%zz`) with their own `400`
before WordPress, Symfony or Rails ever run, for every caller and every URL. That is not the CMS reading the path before the
door, so `doors.door-comes-first` does not count it against you, but only when the same escape also gets a non-CMS `400` on a
URL outside the CMS's own (`/%zz` at the root of the host). The check then passes with a `note:` line that says so. A CMS mounted
at the root of its host has no "outside", so it gets no such excuse, and a `400` from the CMS's own URLs still fails.

## Decision notifications: the `notify` group

A CMS may tell the agent when a person has decided, instead of the agent asking
([spec](../docs/spec.md#decision-notifications-optional)). The suite checks that only if you ask for it:

1. Configure the CMS under test to send its notifications to `http://<this machine>:<port>/` (any path) and, if you want to
   test signing, with a secret. The receiver URL is the CMS operator's setting, never the agent's: on WordPress
   `HERMES_APPROVAL_WEBHOOK_URL` and `HERMES_APPROVAL_WEBHOOK_SECRET` in `wp-config.php`; on .NET `HERMES_WEBHOOK_URL` and
   `HERMES_WEBHOOK_SECRET`; on the Node demo `WEBHOOK_URL` and `WEBHOOK_SECRET`.
2. Put the same port and secret in the profile, `"notify": { "port": 8795, "secret": "demo-secret" }` (add `"host": "0.0.0.0"` when
   the CMS runs on another machine), or pass `--notify-port 8795 --notify-secret demo-secret [--notify-host ...]`.
3. Run the suite. It listens on that port for the whole run and the `notify` checks use it as a receiver they can make fail,
   hang, redirect or disappear. Without the setting the nine checks are reported as `skip`.

```bash
WEBHOOK_URL=http://127.0.0.1:8795/hook WEBHOOK_SECRET=demo-secret npm start                  # terminal 1
node conformance/run.mjs --config conformance/profiles/demo-cms-notify.json                   # terminal 2
```

`receiver-failure-is-harmless` is the one that protects the reviewer: a CMS whose decision fails because the agent's
server is down has made its own availability depend on someone else's. `slow-receiver-does-not-delay-decisions` is a
recommendation: a server that cannot detach from the request (PHP under Apache `mod_php` or `php -S`) waits for the 3 second
time-out at most, and is reported as a warning.

## Reading the result

* `FAIL` is a MUST: your implementation breaks the contract. Do not go live.
* `warn` is a recommendation (hygiene, optional features).
* `skip` means a setting was missing (for example no `--verify-url`). Skips are
  gaps in your evidence, so fill the setting in rather than ignoring them.

## Porting checklist (what usually fails first)

1. Atomic claim: `UPDATE approvals SET status='Consumed' WHERE id=? AND status='Approved'`
   and check that exactly one row changed. A read-then-write fails `concurrency.*`.
2. Same transaction: claim, apply the content change and audit in one
   transaction; on failure roll back to `Approved`.
3. Canonical JSON: compare payloads with sorted keys at every depth, after
   removing `approvalId`.
4. UTF-8 end to end: database column, connection and JSON body.
5. Reviewer door: decide routes read your login session, never an API key.

## What no script can prove (do these by hand)

The suite cannot see your login system or your infrastructure. Before launch:

1. Real manager login: log in as a manager in a browser and approve a
   request, then log in as a normal editor and confirm approve is refused.
2. CSRF: replay a captured approve request from another origin or without
   the anti-forgery token; it must fail.
3. Bypass attempt: with only the agent's keys, try to call your CMS's normal
   admin or content API directly. If anything works, the queue can be skipped.
4. Failed write in production conditions: the suite checks a refused save
   (`failingPayload`). Also try a real infrastructure failure on staging, for
   example revoke a DB permission: the approval must return to `Approved` and
   a retry must then succeed.
5. Expiry: seed an approval whose `expiresUtc` is in the past and pass it
   as `expiredFixture`; the write must be `APPROVAL_EXPIRED`.
6. Audit: confirm every executed write left an audit row naming the
   approval id, the reviewer and the exact JSON.

## Profile settings

| Key | Meaning |
| --- | --- |
| `baseUrl`, `writeHeader`, `readHeader`, `reviewHeaders` | where the API is and how each door authenticates (any headers: `Authorization: Basic ...`, `Cookie` + `X-WP-Nonce`, ...) |
| `resourceType`, `resourceId`, `action`, `scope`, `payload` | one real test resource and a valid change to it; `payload` must contain `{{uid}}` |
| `otherAction`, `otherScope`, `deleteAction` | a second action (binding checks) and a `delete:*` action (submit only; it is never written against your resource) |
| `verifyUrl`, `verifyField`, `verifyHeaders` | read the resource through a path that does not use the approval API |
| `failingPayload` | a payload your CMS will refuse after it has started saving (so the check proves the rollback) |
| `timeoutMs` | how long to wait for any one answer (default 30000). A request that gets none is a failed check (`HTTP 0`), never a hang |
| `expiredFixture` | an approval you seeded as `Approved` with an `expiresUtc` in the past |
| `notify` | `{ "port", "secret", "host" }`: where the suite listens for the CMS's decision notifications, and the secret they are signed with (`""` for unsigned). Enables the `notify` group |

`profiles/` holds ready profiles for the stacks in this repository. `demo-cms.json` and `dotnet-sqlserver.json` use the demo keys
as they are. `wordpress.json` is a template: run `ports/php/wordpress/test/setup.php` against a throwaway WordPress to
get a working `wordpress.local.json` (git-ignored, because it holds test credentials).

## Comparing stacks: the differential probe

```bash
node conformance/differential.mjs --config a.json --config b.json --config c.json
```

Sends 98 awkward requests (parsing, numbers, text, types, paths, queries, decisions, write bodies) to every
profile and prints a table of `HTTP status + error code`, marking each row where the stacks disagree.
A disagreement is a bug in at least one of them: two stacks read the same bytes differently. Local targets only.

## Fuzzing the stacks against each other

```bash
node conformance/fuzz.mjs --config a.json --config b.json --config c.json --seed 1 --cases 5000
```

The probe replays cases somebody thought of. The fuzzer generates the rest: hostile paths, query strings and headers,
request framing (chunked bodies, a missing or wrong `Content-Type`, odd methods) and JSON bodies made by mutating a valid
one (a duplicate key, a lone surrogate, a number at the edge of a double, deep nesting, a field of the wrong type). The same
generated request goes to every profile and the answers are compared as `HTTP status + error code` plus the canonical
echo of what was stored. Anything the stacks answer differently is a finding.

* The same `--seed` and `--cases` generate the same requests. A finding prints its id (`seed:index`) and
  `--replay 4:342` sends just that request again.
* A finding is shrunk to a smaller request that still shows the disagreement (`--no-shrink` turns that off), and findings
  with the same signature are grouped.
* A 5xx or a dropped connection is reported as a server error even when every stack agrees on it.
* `--only submitBody,readPath,...` picks request families (`submitBody`, `readPath`, `getProposal`, `decideBody`,
  `writeBody`, `headers`, `listQuery`, `framing`, `methods`), `--parallel` sets the requests in flight, `--json file` writes
  the whole report.
* It creates, approves and writes thousands of rows: local test targets only. A request that the Node client itself refuses
  to send (an illegal header character) is skipped, not counted.

## How we know the suite itself is trustworthy

`test/e2e/conformance.test.mjs` runs it against the reference server (must pass)
and against sixteen deliberately broken servers: unbound payload, approval never
consumed, non-atomic claim, write while Pending, agent key that can approve,
no input validation, plain `JSON.parse` for bodies, paths decoded twice, a trailing
newline tolerated after an id, paths normalized before routing, the body parsed before
the door, a malformed `%` escape answered with `400` before the door, `Content-Type` ignored,
case-insensitive query names, `X_Api_Key` read as `X-Api-Key`, and a reason of any type accepted.
Each one must be reported as non-conformant by the check that guards that rule. A seventeenth case
runs the other way: a web server in front that refuses the escape for every URL must not be blamed on the CMS.

The `notify` group has twelve more of its own: a notification that carries the proposal and the reasons, one that says
`Approved` whatever was decided, one sent twice, signature headers left out or made with another secret, a submit announced, a
refused decision announced, a decision that fails when the receiver fails, a reviewer who waits for the receiver, a redirect
followed, a failed delivery retried, and a manifest that says nothing.
