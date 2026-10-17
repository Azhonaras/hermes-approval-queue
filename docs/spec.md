# Human approval contract

This is the HTTP contract a Hermes-style agent uses to propose writes to your
CMS. A human on your review page decides, and the agent then executes the same
JSON once.

This sample is not a hosted CMS. The dummy keys work only against the demo CMS
in this repo. When you implement the routes, point the same client at your own
base URL.

## Protocol vs example

| Layer | Stable | In this demo CMS only |
| --- | --- | --- |
| Doors, statuses, envelopes, bind + consume-once | yes | |
| Base path `/api/seo` | | example mount |
| Actions like `update:canonical`, scopes like `seo:write` | | example profile |

Your CMS may use `/api/approvals` and actions such as `publish:post`. Each
action must map to one write path.

## Doors

| Door | Header (example names) | May |
| --- | --- | --- |
| Read | `X-Api-Key` (read) | `GET /ping`, `/manifest`, `/resources/{type}/{id}`, `/proposals/{id}` |
| Write | `X-Api-Key` (write) | All read + `POST /proposals` + `POST /writes` |
| Review | Your manager session | List queue/history + approve / reject / request-changes |

The write key cannot approve. The review session cannot submit or execute a
write. The agent has no key that can decide.

Demo review header: `X-Review-Session: demo-manager`  
Demo keys: `demo-read`, `demo-write`  
Demo base URL: `http://127.0.0.1:8790/api/seo`

## Statuses

`Pending` → `Approved` | `Rejected` | `ChangesRequested` | `Expired`  
`Approved` → `Consumed` (matching write) or `Expired`  
`ChangesRequested` → new `Pending` (new id, `revisionOfApprovalId` set)

## Routes

Paths are relative to your base path.

| Method | Path | Door | Purpose |
| --- | --- | --- | --- |
| GET | `/ping` | none | Liveness |
| GET | `/manifest` | read | Version, lifecycle, actions, scopes, limits; optionally the fields per action |
| POST | `/proposals` | write | Submit immutable JSON |
| GET | `/resources/{type}/{id}` | read | Read CMS content directly (no approval needed) |
| GET | `/proposals/{id}` | read | Poll one row |
| GET | `/proposals?status=` | review | `pending` or `history` |
| POST | `/proposals/{id}/approve` | review | Human approve. Optional `proposal` replaces the agent's JSON (the edit) |
| POST | `/proposals/{id}/reject` | review | Reason required |
| POST | `/proposals/{id}/request-changes` | review | Feedback required |
| POST | `/writes` | write | Redeem `approvalId` + same body |

## Manifest

`GET /manifest` returns `version`, `baseUrl`, `authHeader`, `actions`, `scopes`, `approvalLifecycle` and `limits`. It
MAY also return `fields`: each action mapped to the `proposal` fields its write path accepts.

```json
{ "fields": { "update:onpage": ["title", "excerpt", "slug", "titleSeo", "descriptionSeo"], "delete:post": [] } }
```

An agent should take field names from here instead of guessing them, and a review page should warn about any other
field, because that write would fail. `fields` is advisory: the queue still accepts any JSON object, and the CMS's write
path has the last word. (The WordPress plugin returns it; the Node demo does not.)

It MAY also return `notifications` (see "Decision notifications" below).

## Submit body

```json
{
  "siteId": 1,
  "resourceType": "article",
  "resourceId": 42,
  "action": "update:canonical",
  "scope": "seo:write",
  "reason": "Canonical is empty.",
  "proposal": { "canonical": "https://example.com/guide" },
  "revisionOfApprovalId": null
}
```

`action` and `scope` are strings you define. The demo CMS SEO profile uses:

Actions: `update:onpage`, `update:canonical`, `update:redirect`,
`update:schema`, `update:indexing`, `update:contentlinks`,
`create:taxonomy`, `update:taxonomy`, `delete:taxonomy`, `merge:taxonomy`.

Scopes: `seo:write`, `content:update`, `schema:manage`.

`resourceType` and `resourceId` are required. `proposal` must be a JSON
object. Limits (recommended): 40 proposal fields, 16384 JSON characters,
and 1024 reason characters. `delete:*` may send an empty object.

A revision must keep its parent's site, resource, action, and scope. Only
the reason and proposal may change.

Do not use a bare `update`. One approval must not unlock a different
endpoint.

## Reviewer edits

The reviewer may change the JSON before approving: `POST /proposals/{id}/approve`
with `{ "reason": "", "proposal": { ... } }`. The stored `proposal` becomes the
edited JSON, `editedProposal` is `true`, and the agent's original is kept in
`originalProposal`. The agent must then redeem the edited JSON; its original
body gets `409 APPROVAL_PAYLOAD_MISMATCH`. Only approve can carry an edit, and the
edit obeys the same size caps as a submission.

## Write body

```json
{
  "approvalId": 1042,
  "resourceType": "article",
  "resourceId": 42,
  "action": "update:canonical",
  "scope": "seo:write",
  "proposal": { "canonical": "https://example.com/guide" }
}
```

The guard compares resource, action, scope, id, and canonical JSON
(stable key order). A mismatch or a second redeem gets `409`. Otherwise your
CMS applies the write with its own save function. If that save throws, the row
returns to `Approved` and the agent gets `502 WRITE_FAILED` and may retry.

## Envelope

Success: `{ "success": true, "data": { ... } }`  
Error: `{ "success": false, "error": { "code", "message" } }`

| Code | HTTP |
| --- | --- |
| `SCOPE_DENIED` | 403 |
| `APPROVAL_PENDING` | 409 |
| `APPROVAL_NOT_USABLE` | 409 |
| `APPROVAL_PAYLOAD_MISMATCH` | 409 |
| `APPROVAL_MISMATCH` | 409 |
| `APPROVAL_EXPIRED` | 409 |
| `REVISION_NOT_REQUESTED` | 409 |
| `REVISION_MISMATCH` | 409 |
| `APPROVAL_NOT_PENDING` | 409 |
| `DECISION_REASON_REQUIRED` | 400 |
| `BAD_REQUEST` | 400 |
| `UNAUTHORIZED` | 401 |
| `NOT_FOUND` | 404 |
| `PAYLOAD_TOO_LARGE` | 413 |
| `UNSUPPORTED_MEDIA_TYPE` | 415 |
| `WRITE_FAILED` | 502 |

A request that cannot be understood at all (a malformed HTTP request line, an unknown host) may be answered by the
web server instead of this API and is outside the envelope.

Proposal DTO: `approvalId`, `siteId`, `resourceType`, `resourceId`,
`action`, `scope`, `status`, `reason`, `proposal`, `decisionReason`,
`revisionOfApprovalId`, `createdUtc`, `decidedUtc`, `decidedBy`,
`expiresUtc`, `editedProposal`, `originalProposal`.

## Decision notifications (optional)

An agent that would otherwise keep asking "has a person decided yet?" can be told instead. A CMS MAY send a
notification to a receiver URL when a reviewer decides. The notification only names the request and its new state. The
agent still reads the row with `GET /proposals/{id}` and redeems it with `POST /writes` through its own key, so the
doors, the statuses and the write guard stay as they are.

Setup: the CMS's operator configures the receiver URL (and an optional secret) in the CMS itself. The agent never does.
If the agent could choose the URL, it could make the CMS call any address on the CMS's own network.

When it is sent: once, after a reviewer's `approve`, `reject` or `request-changes` has been stored. Not for a
submit, a write, an expiry, a decision that was refused (`400`, `403`, `409`), or a decision that lost a race to
another one.

What is sent: `POST <receiver url>` with `Content-Type: application/json` and exactly this body, compact, in this
order:

```json
{"event":"decision","approvalId":1042,"status":"Approved","decidedUtc":"2026-10-16T01:40:12.345Z"}
```

`status` is `Approved`, `Rejected` or `ChangesRequested`; `decidedUtc` is the row's own value. There is no other field:
no proposal, no reason, no resource, no reviewer. A receiver may be a third-party service, so content stays behind the
agent's key. A receiver ignores events and fields it does not know.

| Header | Value |
| --- | --- |
| `X-Hermes-Delivery` | A unique id for this attempt. Always sent |
| `X-Hermes-Timestamp` | Unix seconds when it was sent. Sent when a secret is configured |
| `X-Hermes-Signature` | `sha256=` and the lowercase hex HMAC-SHA256 of the text `<timestamp>.<raw body>` with the secret. Sent when a secret is configured |

A receiver that has a secret recomputes the HMAC over the raw bytes it received, compares in constant time and
refuses a timestamp more than five minutes away from its own clock. Without a secret there is no proof of origin, and a
receiver must not do more than go and look: a forged nudge can then only cause one extra `GET`.

A test vector for the signature: secret `s3cret`, timestamp `1760580012` and the body shown above give

```
sha256=8bd76bf7597eacb8a5c71c7b0485d267471f99bd208bc604aa570511a236f684
```

How it is delivered: at most once, best effort, no retry. The CMS waits at most three seconds for an answer, does
not follow redirects, and treats any answer, or none, as final. A receiver that is down, slow or answering `500` never
changes the decision or the reviewer's answer (`MUST`). The CMS SHOULD send after it has answered the reviewer, or in
the background, so the reviewer never waits for the agent's server (a stack that cannot detach may wait up to the
three seconds). Two quick decisions can arrive out of order, and a nudge can arrive before the reviewer's page has
redrawn. The agent therefore keeps a slow poll of `GET /proposals/{id}` as its safety net.

Manifest: a CMS that sends notifications MAY say so in `GET /manifest`: `"notifications": { "decision": true,
"signed": true }`. The field is absent otherwise. `signed` tells the agent whether to insist on the headers above.

## Strict input

Every stack must read the same bytes the same way. These rules are part of the contract and are
checked by the `edge.*` conformance group; each one exists because two real stacks once disagreed.

### Order of checks

Every stack answers the same request with the same status, so the checks run in one order and the first failure wins:

1. the route (`404`): method + path, matched on the raw request target;
2. a NUL in the path (`400`);
3. the door: no or wrong key `401`, a key without the right scope or a reviewer without the right role `403`;
4. path segments and query string (`400`);
5. `Content-Type` (`415`);
6. body size (`413`);
7. JSON syntax and field types (`400`);
8. the row or the resource (`404`);
9. its state (`409`);
10. the reason a reject or request-changes needs (`400 DECISION_REASON_REQUIRED`).

So an unauthenticated caller learns nothing about the shape of a body, and a body is never read for a caller who may not send one.

### Request body

| Rule | Result |
| --- | --- |
| `Content-Type` is not `application/json` (parameters such as `; charset=utf-8` and letter case are ignored) | `415 UNSUPPORTED_MEDIA_TYPE`, also when the body is empty |
| No `Content-Type` and an empty body | accepted (`{}`); no `Content-Type` with a body is `415`. Where the server cannot tell an empty `Content-Type` from a missing one (FastCGI, CGI) the empty value counts as missing |
| Body is empty | treated as `{}` |
| Body is not one JSON **object** (an array, `null`, a string, a number) | `400 BAD_REQUEST` |
| Body is larger than 200,000 bytes | `413 PAYLOAD_TOO_LARGE` (the server still reads the rest, so the client can see the answer) |
| Not valid UTF-8, or a UTF-8 encoded surrogate | `400` |
| Unpaired surrogate in a `\uXXXX` escape (`"\ud800"`) | `400` (a pair such as `😀` is fine) |
| Duplicate key in any object, at any depth | `400` (parsers disagree on which one wins) |
| More than 32 nested containers, counting the body object as the first | `400` |
| Anything after the JSON value, a BOM, a comment, a trailing comma, `NaN` | `400` |
| Control characters inside a string | `400` |
| A key named `__proto__` or `constructor`, an empty key `""`, a key with a NUL | ordinary data, stored and returned unchanged |

### Numbers

Numbers are IEEE-754 doubles on every stack, because that is what JavaScript clients send and read.

* An **integer literal** (no `.`, no exponent) beyond ±9007199254740991 is `400`: it would silently lose digits
  in some stacks. Send larger numbers as strings.
* A number that is not finite (`1e999`) is `400`.
* `-0` is `0`. A whole number is the same number however it is written: `1`, `1.0`, `1e0`, `10e-1`
  are equal to the guard, and a reviewer sees `1`.
* Numbers are printed the way `JSON.stringify` prints them (`1e+21`, `1.5e-7`), which is also how sizes are counted.

### Sizes

* "Characters" always means **UTF-16 code units of the compact JSON text**, the same count as JavaScript's
  `JSON.stringify(x).length`. An emoji counts 2, a Persian letter counts 1, and nothing is counted twice for
  escaping (`<`, `&`, `"é"` are not expanded).
* `proposal`: at most 16384 characters and 40 top-level fields. `reason` (submit **and** decision): at most 1024.
  `resourceType`: at most 100. `resourceId`: at most 200 characters as JSON (a string counts its two quotes).
  Longer is `400`, never a database error.

### Types

Wrongly typed fields are `400`, they are never coerced: `siteId` and `revisionOfApprovalId` must be integers
(`siteId` between 1 and 999,999,999, the same range as in the query string), `reason` a string, `action` and `scope` strings, `resourceId` a string or a number (not an object, array or boolean),
and `approvalId` an integer (not `"12"`). In a write body, a field of the wrong type is simply a mismatch
(`409 APPROVAL_MISMATCH` or `APPROVAL_PAYLOAD_MISMATCH`), never a server error.

* The id `42` and the id `"42"` are different resources, for the guard and for storage.
* A whole-number `resourceId` is the integer however it was written (`42.0` is `42`).
* `siteId` in a write body is optional; if present it must be the row's own site.
* `proposal` in a write body: absent or `null` means `{}` (what a `delete:*` approval holds); anything else is
  compared as it is, so `false` or `0` never stand in for `{}`.

### Text

`resourceType` is trimmed like JavaScript's `String.prototype.trim()`: tab, newline, `\v`, `\f`, `\r`, space,
U+00A0, U+1680, U+2000 to U+200A, U+2028, U+2029, U+202F, U+205F, U+3000 **and U+FEFF** are removed;
U+0085 is **not**. Decision reasons are trimmed the same way. Text is stored and returned exactly as sent (Persian,
emoji and NUL included); nothing is normalised.

### Path and query

* Routing uses the **raw request target**, exactly as sent. Nothing is normalised before the route is chosen: `..`,
  `%2e%2e`, `//` and a backslash do not collapse into another route, they are simply not a route (`404`).
* Path segments are split on `/` first and **percent-decoded exactly once** afterwards. `%2F` stays inside a
  segment. A malformed escape (`%zz`, a lone `%`) or bytes that are not UTF-8 after decoding are `400`.
* A NUL in the path (`%00`, raw or decoded) is `400`. A web server in front may answer first with its own `400` or
  `404` page (Kestrel and Apache do); that is outside the envelope.
* A numeric id or `siteId` is digits **only**. A trailing newline or space makes it invalid (`siteId`) or a string
  (a resource id); a regex that lets `$` match before a final newline gets this wrong.
* In `GET /resources/{type}/{id}`, a segment that is a canonical integer (`0`, `42`, `-7`, at most 15 digits)
  is that **number**; anything else (`0042`, `+42`, `42.0`, `abc`) is a **string**.
* `GET /proposals/{id}`: digits only; an id too large to exist is `404`. Leading zeros are ignored.
* `siteId` (query): absent is `1`; otherwise a positive integer of at most nine digits, else `400`.
* `status` (query): absent or empty is `pending`; otherwise `pending` or `history`, compared case-insensitively
  for ASCII letters only (a dotted capital I is not an `i`), else `400`.
* A parameter given twice: the **first** value wins. `name[]=x` is a different parameter and is ignored. Parameter
  names are matched exactly and case-sensitively (`SITEID` is not `siteId`), and `;` is not a separator.
* A trailing slash (`/proposals/`) or a different case (`/PROPOSALS`) is not the route: `404`.
* Method-override headers and `_method` are not part of the contract.
* `OPTIONS`, `HEAD`, `TRACE` and made-up methods are outside the contract: a stack may answer them as its web
  server or framework does.

### Headers

* Spaces and tabs around the value of the agent key header are not part of the key (`MUST`).
* The agent key is read from `X-Api-Key` by that dashed name, and `X_Api_Key` is not that header (`SHOULD`). PHP folds both
  into the same variable under most SAPIs (FPM, CGI, WordPress Playground) and cannot tell them apart, so the conformance
  suite only warns there; the key is still required either way.
* The reviewer's credential is whatever the CMS already uses for its own users (`X-Review-Session` in the Node
  demo, a cookie and `X-WP-Nonce` or an Application Password in WordPress).

### Stored data

Rules may tighten over time. A store must read back every row it ever wrote: stored JSON is parsed leniently
(no number-size or nesting limits), never with the request rules.

### Decisions

`POST /proposals/{id}/{approve|reject|request-changes}` follows the order of checks above: the door (`401`/`403`),
the media type and the shape of the body (`415`/`400`: `reason` must be a string of at most 1024 characters,
`proposal` is allowed on `approve` only and must be a non-empty object), then the row (`404`), its state
(`409 APPROVAL_NOT_PENDING`), and finally the reason a reject or request-changes needs
(`400 DECISION_REASON_REQUIRED`).

### A failed save

If the CMS refuses the write (a validation error, a database error), **nothing** it did may survive: the
approval is `Approved` again, the content is unchanged (a partial write is rolled back with the claim), and the
agent gets `502 WRITE_FAILED` and may retry. Stores that can do so claim and write in one transaction.
