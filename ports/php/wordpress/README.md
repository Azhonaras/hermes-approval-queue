# WordPress plugin: Hermes Approval Queue

An AI agent proposes a change to a post or a term over REST. Nothing is saved until a signed-in WordPress user with the
right capability approves it (optionally after editing it), and then the agent redeems exactly that approved JSON, once.
It is the [contract](../../../docs/spec.md) running on WordPress, on top of the [PHP core](../core/).

```
https://your-site/wp-json/hermes-approval/v1/...
```

## Install

```bash
node ports/php/wordpress/build.mjs          # -> ports/php/wordpress/dist/hermes-approval/ (plugin + core in lib/ + review page in ui/)
```

Copy `dist/hermes-approval/` to `wp-content/plugins/`, activate it, and add to `wp-config.php`:

```php
define( 'HERMES_APPROVAL_READ_KEYS',  'long-random-read-key' );    // agent keys that may read; comma-separated for several
define( 'HERMES_APPROVAL_WRITE_KEYS', 'long-random-write-key' );   // agent keys that may submit and redeem (never approve)
// optional
define( 'HERMES_APPROVAL_REVIEW_CAP', 'edit_others_posts' );       // capability a reviewer needs (this is the default)
define( 'HERMES_APPROVAL_CORS_ORIGIN', 'https://review.example.com' ); // only if a page on another origin calls the API
define( 'HERMES_APPROVAL_WEBHOOK_URL',    'https://agent.example/hooks/hermes' ); // tell the agent's server when a person decides
define( 'HERMES_APPROVAL_WEBHOOK_SECRET', 'long-random-secret' );  // sign those notifications (see "Telling the agent")
```

Reviewers then open Agent requests in the admin menu (see "The review page" below).

Requires PHP 8.1+ with `mbstring`, and MySQL 5.7+ / MariaDB 10.3+ with InnoDB (the claim and the content change must
share one transaction). Activation creates `{prefix}hermes_approvals` and `{prefix}hermes_audit`.
SQLite (WordPress's SQLite Database Integration plugin, which is what WordPress Playground runs) is verified too; see
"Try it on WordPress Playground" below.

## The two doors

| | Agent | Reviewer |
| --- | --- | --- |
| Who | A static key from `wp-config.php`, sent as `X-Api-Key` | A WordPress user who has the capability |
| How | Header only. Keys are compared in constant time | Browser: the login cookie plus the `X-WP-Nonce` header. Scripts: an Application Password |
| Can | Read, submit a proposal, poll it, redeem an approved write | List the queue, approve (optionally with an edited `proposal`), reject, request changes |
| Cannot | Approve, reject or list, whatever else it sends | Submit or write |

* A logged-in cookie without the REST nonce is not a reviewer, so another site cannot make your browser approve
  anything (this is WordPress's own CSRF protection; the suite proves it).
* The write key plus a valid reviewer session in the same request still cannot approve.
* The change is saved as the reviewer who approved it: WordPress checks that user's rights, attributes the revision to
  them and filters HTML by their role. An approval never grants more than its approver has. (`limited` in the tests may
  approve but may not edit published posts: their approval is accepted, the write is refused with `502 WRITE_FAILED`
  and the post is untouched. The rights are checked when the agent writes, not yet when the reviewer approves; see
  "Not proven".)

## The review page

Users with the review capability see Agent requests in the wp-admin menu, with a count of the requests waiting. It
is the same review UI as the demo (`demo/`, copied into `ui/` by `build.mjs`), shown in a frame and signed in as the
current WordPress user: the login cookie plus a REST nonce, never an agent key. On it a reviewer:

* sees each request with the agent's reason, the exact JSON, and a before/after table: what the post or term holds now
  (read through the API as the reviewer) next to what will be written;
* approves (optionally after editing the JSON), rejects, or requests changes, one request or many at once;
* is warned when a field has no write path for that action (from the manifest's `fields`): such a change would fail when
  the agent runs it, so request changes instead;
* sees History: who decided what, and which approvals were edited.

The frame's document is `wp-admin/admin.php?page=hermes-approval&frame=1`, sent with `X-Frame-Options: SAMEORIGIN`. A copy
of the plugin built without `ui/` says so on that page instead of showing a blank frame.

## Telling the agent when you decide

Without this the agent has to ask `GET /proposals/{id}` every few seconds. With `HERMES_APPROVAL_WEBHOOK_URL` set, the plugin
posts a short notification to that URL after each approve, reject or request-changes
([spec](../../../docs/spec.md#decision-notifications-optional)):

```
POST https://agent.example/hooks/hermes
X-Hermes-Delivery: 5c0e...        X-Hermes-Timestamp: 1760580012        X-Hermes-Signature: sha256=8bd7...
{"event":"decision","approvalId":1042,"status":"Approved","decidedUtc":"2026-10-16T01:40:12.345Z"}
```

* It is a nudge only: the id and the new state, never the proposal, the reason or the content. The agent still reads the row and
  redeems it with its own key, so nothing about the doors or the write guard changes.
* Only the site's operator can set the receiver, in `wp-config.php`. The agent cannot, or it could aim the site at any
  address it can reach. The URL must be plain `http`/`https` without a user name; anything else turns notifications off and
  logs why. Redirects are not followed.
* With `HERMES_APPROVAL_WEBHOOK_SECRET` the request carries an HMAC (`sha256` over `<timestamp>.<raw body>`); without it
  there is no proof of origin and the receiver should treat the nudge as a hint. The agent-side receiver in
  [`src/receiver.js`](../../../src/receiver.js) checks the signature and the clock for you.
* Sent once, 3 seconds at most, no retry. A receiver that is down, slow or answering `500` changes nothing about the decision
  (the failure goes to the PHP error log). The agent therefore keeps a slow poll as a safety net.
* The request goes out in WordPress's `shutdown` action, after the answer has been handed to the web server where PHP can
  do that (PHP-FPM, LiteSpeed). On Apache `mod_php` and on `php -S` the reviewer's click waits for the receiver, up to
  the 3 seconds, and the suite's `notify.slow-receiver-does-not-delay-decisions` says so as a warning.
* If your site sets `WP_HTTP_BLOCK_EXTERNAL`, add the receiver's host to `WP_ACCESSIBLE_HOSTS`. (The site's own host is
  always allowed.)
* `GET /manifest` then carries `"notifications": {"decision": true, "signed": true}`.

The conformance profile gets a `notify` block (`setup.php` writes it when `wp-config.php` points the URL at 127.0.0.1) and the
suite listens on that port for its `notify` group.

Tested behind nginx + PHP-FPM, the way most WordPress sites run: the full suite is 84 of 84 (the reviewer's answer comes
back at once even when the receiver never answers). Behind `php -S` it is 83 plus the one warning above. Two things differ
behind a real web server, and neither is the plugin's doing: nginx and Apache answer a malformed `%` escape (`/%zz`) with
their own `400` before WordPress runs, and FastCGI gives PHP an empty `CONTENT_TYPE` for a request without one (the plugin
reads that as "none"). The suite, the probe and the fuzzer know both.

## What an action does

Resource types are post types (`post`, `page`, your custom types) addressed by post ID, and `term` addressed by term ID.
Each action has one write path and a whitelist of fields; a field outside the whitelist is refused, never silently saved.

| Action | Resource | Fields in `proposal` | Written with |
| --- | --- | --- | --- |
| `update:onpage` | post type | `title`, `excerpt`, `slug`; `titleSeo`, `descriptionSeo` (post meta) | `wp_update_post`, `update_post_meta` |
| `update:content` | post type | `content` (the post body, block markup included) | `wp_update_post` |
| `delete:post` | post type | none (`{}`) | `wp_trash_post`: the post goes to the trash, where an editor can restore it (needs `delete_post`) |
| `update:canonical` | post type | `canonical` (absolute http(s) URL or empty) | `update_post_meta` |
| `update:redirect` | post type | `redirect` (absolute http(s) URL or empty) | `update_post_meta` |
| `update:indexing` | post type | `noindex` (boolean) | `update_post_meta` |
| `update:schema` | post type | `schema` (JSON object) | `update_post_meta` |
| `update:taxonomy` | `term` | `name`, `slug`, `description` | `wp_update_term` |
| `delete:taxonomy` | `term` | none | `wp_delete_term` |
| `merge:taxonomy` | `term` | `into` (id of an existing term) | `wp_delete_term` with a replacement |

The SEO meta keys are stored as `_hermes_canonical`, `_hermes_title_seo`, `_hermes_description_seo`, `_hermes_redirect`,
`_hermes_noindex`, `_hermes_schema`. To make them drive your SEO plugin, change the map at the top of
[`WpCmsAdapter.php`](hermes-approval/src/WpCmsAdapter.php) to that plugin's meta keys. Add a new action by adding it to
`Profile` in the core and a write path to the adapter.

The manifest (`GET /manifest`) lists these fields per action under `fields`, so an agent can learn the names instead of
guessing them. Reads (`GET /resources/{type}/{id}`) need only the read key and skip the queue; a read of a post includes
its `content`.

## What visitors see

WordPress never prints the plugin's own meta keys, so the plugin does ([`Frontend.php`](hermes-approval/src/Frontend.php)):
on a single post or page it prints the approved SEO title as the `<title>`, the meta description, the canonical (instead
of WordPress's own, so there is exactly one), `noindex` in the robots tag, the JSON-LD (escaped so a value cannot close
the script element), and answers with a `301` to an approved redirect. Archives, search and feeds are left alone.

When Yoast SEO, Rank Math, All in One SEO, SEOPress or The SEO Framework is active, this output switches itself off (two
canonicals are worse than one). Then point the meta keys in `WpCmsAdapter.php` at that plugin's keys. The
`hermes_approval_frontend` filter turns the output on or off by hand.

## Why a failed write leaves nothing behind

`WpdbStore::consumeOnce` starts a transaction on `$wpdb`'s own connection, claims the row
(`UPDATE ... SET status='Consumed' WHERE approval_id=? AND status='Approved'`), runs the adapter (WordPress's save
functions use the same connection, so they join it), inserts the audit row and commits. If the adapter throws, everything
rolls back: the row is `Approved` again and the content is as it was. The object cache is cleared for that resource so
no stale value survives the rollback. Deadlocks and lock-wait timeouts (MySQL 1205/1213) are retried up to four times.

## Try it on a throwaway site

Never run this on a real site: it creates users and application passwords.

```bash
composer create-project roots/wordpress-full wp-test          # or any WordPress folder
cp ports/php/wordpress/test/wp-config.test.php wp-test/wp-config.php      # then edit the DB_* lines
ln -s "$PWD/ports/php/wordpress/dist/hermes-approval" wp-test/wp-content/plugins/hermes-approval   # after build.mjs
cd wp-test && PHP_CLI_SERVER_WORKERS=16 php -S 127.0.0.1:8792 ../ports/php/wordpress/test/router.php &
HERMES_WP_ROOT="$PWD" HERMES_WP_URL=http://127.0.0.1:8792 php ../ports/php/wordpress/test/setup.php
cd .. && node conformance/run.mjs --config conformance/profiles/wordpress.local.json --yes
node ports/php/wordpress/test/real-scenarios.mjs http://127.0.0.1:8792/wp-json/hermes-approval/v1 ports/php/wordpress/test/wp-creds.local.json
```

`setup.php` writes `conformance/profiles/wordpress.local.json` and `test/wp-creds.local.json` (both git-ignored, both hold
live credentials of the test site). It refuses to run unless `WP_ENVIRONMENT_TYPE` is `local` or `development`.

`real-scenarios.mjs` covers what the generic suite cannot express: an author cannot approve; a cookie without the nonce
is not a reviewer; the same cookie with the nonce approves and is recorded as that user; the write key plus a browser
session still cannot approve; an approval does not exceed the approver's rights; Persian and emoji text lands in a real
post title unchanged; a failing field after a saved title rolls the title back; a real category is renamed and deleted
through the queue; a field outside the whitelist is refused; backslashes in an approved title, SEO title and category
description are saved as written; the post body changes through the queue; an approved delete moves a post to the trash;
approved SEO fields reach the live page (one canonical, the meta description, the `<title>`); the manifest lists each
action's fields; invalid JSON gets the spec's error envelope; no CORS headers go to a foreign origin.

## Try it on WordPress Playground (SQLite)

Playground needs no database, so this is the quickest way to watch the queue work.

```bash
node ports/php/wordpress/build.mjs
npx @wp-playground/cli server --port=8881 \
  --blueprint=ports/php/wordpress/playground/blueprint.json \
  --mount="$PWD/ports/php/wordpress/dist/hermes-approval:/wordpress/wp-content/plugins/hermes-approval"
# in a second terminal, when it prints "Ready":
node ports/php/wordpress/test/playground-check.mjs http://127.0.0.1:8881
```

The [blueprint](playground/blueprint.json) sets pretty permalinks, defines the demo agent keys (`demo-read`,
`demo-write`: **demo only**), activates the plugin and seeds one already-expired approval. Sign in at
`/wp-admin` as `admin` / `password` (Playground's default).

`playground-check.mjs` signs in the way a browser does (login cookie plus the REST nonce, see `login.mjs`), creates a
throwaway post, runs the whole conformance suite against the site and deletes the post again. It takes about ten minutes
because Playground answers only a few requests at a time. Expect 70 of 75 checks to pass, 3 to fail and 2 to warn (the 9 notification checks are skipped there).
The three that cannot pass are `edge.hostile-requests-never-5xx`, `edge.path-rules` and `doors.door-comes-first`, because
Playground's own dev server answers `500` to a malformed `%` escape (such as `/%ff`) before PHP runs. The script recognises
exactly those three (see `playground-limits.mjs`), says so, and exits 0; any other failure exits 1. The two warnings are
`edge.paths-are-not-normalized` (the dev server resolves `..` and `\` before PHP sees the path) and
`edge.api-key-header-name` (PHP-WASM folds `X_Api_Key` into `X-Api-Key`). All five pass on PHP + SQLite and on PHP + MariaDB.
`--only edge` runs one group of the suite.

Notes on Playground:

* Application Passwords are off on a plain-http Playground site, so the reviewer there is the login cookie plus
  `X-WP-Nonce`. That is what a real browser reviewer sends, so it is the realistic path anyway.
* Playground started on a whole WordPress folder skips its SQLite setup. Let it install WordPress itself
  (blueprint `preferredVersions.wp`, or `--wp=<version or zip URL>`) and mount only the plugin.
* `real-scenarios.mjs` (below) needs three users with Application Passwords and has not been run on Playground; it was run
  on PHP + SQLite and PHP + MariaDB.

## WordPress behaviours the plugin works around

| WordPress does | Plugin does |
| --- | --- |
| Parses JSON bodies itself and answers bad JSON in its own error shape | drops that verdict for its routes; the core parses the raw body strictly |
| Strips the trailing slash and percent-decodes the route before the plugin sees it | reads the path from `REQUEST_URI` so `/proposals/1/` and `%2534` mean what they mean on the other stacks |
| Re-encodes response data with `wp_json_encode` (numbers, escaping) | sends a pre-encoded body through `rest_pre_serve_request` |
| Reflects any `Origin` with credentials allowed on REST responses | removes those headers unless `HERMES_APPROVAL_CORS_ORIGIN` is set |
| `$_GET` keeps the last repeated query parameter | parses `QUERY_STRING` itself (first value wins, as on the other stacks) |
| `wp_update_post`, `wp_update_term` and `update_post_meta` remove one level of backslashes (they expect form input) | passes them `wp_slash()`ed values, so an approved `C:\Users` is saved as `C:\Users`, not `C:Users` |
| Never prints the plugin's meta keys on the page | `Frontend.php` prints them, unless an SEO plugin is active |

## Not proven

* SQLite under real load. The store uses MySQL syntax (`DATETIME(3)`, `ENGINE=InnoDB`, `START TRANSACTION`) and the
  SQLite plugin translates it; the suite passes there, including the "failed write leaves nothing behind" checks. SQLite
  lets one writer at a time in, so its concurrency results say little about MySQL under parallel load. The MariaDB run
  covers that.
* Multisite. `siteId` must equal the current blog ID; no multisite test has been run.
* A real SEO plugin. The meta keys above are the plugin's own; with an SEO plugin active, the plugin's front-end
  output switches off and its keys are not yet mapped to that plugin's.
* The review page in other browsers and admin languages. It was used in Chromium, on WordPress 7.1 in English, by an
  editor. The page itself is in Persian only.
* Expiry on a real clock is covered by a seeded, already-expired row, not by waiting.
* Approving something that cannot run. A reviewer can approve a change whose write will fail (they lack the right to
  edit that post; a value the CMS will refuse). The agent then gets `502 WRITE_FAILED` and the row stays `Approved`,
  but the reviewer is not told. The review page now warns about a field the action cannot write; a rights check at
  approve time and a visible "last write error" on the row are still planned.
