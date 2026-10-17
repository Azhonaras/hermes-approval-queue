# PHP core (framework-free)

The rules of [`docs/spec.md`](../../../docs/spec.md) in plain PHP 8.1+, with no framework and no database driver.
Use it under WordPress (see [`../wordpress/`](../wordpress/)), Symfony, Laravel, Drupal or a hand-written site:
you bring a store and a CMS adapter, the core brings everything that must behave identically on every stack.

```
Http/Request.php        path segments, query string and status filter rules ("Strict input" in the spec)
Json.php                strict parser, compact encoder, number text, UTF-16 length, JavaScript-style trim
JObject.php             a JSON object that keeps "0", "" and NUL-prefixed keys (PHP arrays and stdClass cannot)
Validation.php          what an agent may submit and what a reviewer may edit
Guard.php               a write must be the approved write: same resource, action, scope and canonical JSON
ApprovalService.php     submit, decide, execute, readResource, list, get (no HTTP, no SQL)
Notifier.php            optional: told after every stored decision, so the agent need not poll (interface)
Webhook.php             the notification's body, signature, headers and URL check, identical on every stack
Store/ApprovalStore.php the four things your database must do (interface)
CmsAdapter.php          read() and apply(): the only code that touches your content (interface)
```

## What you implement

```php
final class MyStore implements \Hermes\Approval\Store\ApprovalStore { /* insert, get, list, transition, consume */ }
final class MyCms   implements \Hermes\Approval\CmsAdapter          { /* read, apply */ }

$service = \Hermes\Approval\ApprovalService::create(new MyStore(), new MyCms(), \Hermes\Approval\Profile::seo());
```

Optionally pass a `\Hermes\Approval\Notifier` as the fifth argument (`create($store, $cms, $profile, 86400, $notifier)`). The service calls
`decided(Row)` once after each stored approve, reject or request-changes and never lets it undo or fail the decision, so
queue the delivery and send it after your response (`Webhook::body`, `Webhook::headers` give the exact bytes and headers;
`$service->notifications()` is the note for your manifest). The WordPress plugin's `WpNotifier` is the example.

Two methods carry the security of the design:

* `ApprovalStore::transition($id, $from, $patch)` must be a conditional update
  (`UPDATE ... WHERE approval_id = ? AND status = ?`, one row changed or `null`). A read followed by a write is a race.
* `ApprovalStore::consume($id, $now, $apply)` must claim `Approved -> Consumed`, run `$apply`, write the audit row and
  commit in one transaction. If `$apply` throws, the claim rolls back too, so the row is `Approved` again and the
  agent can retry. Retry deadlocks and lock-wait timeouts inside it (MySQL errno 1205 and 1213); the loser was rolled back.

`CmsAdapter::apply(Row $row)` must dispatch on `$row->action` to exactly one write path and throw to refuse.
Reuse your CMS's own save code so its validation, revisions and hooks still run.

## PHP traps this code already handles (do not re-introduce them)

| Trap | What the core does |
| --- | --- |
| `json_decode` accepts duplicate keys, lone surrogates and any depth | its own strict parser; refuses all three |
| `json_decode(..., true)` turns `{}` into `[]` and the key `"0"` into the integer `0` | `JObject`, a wrapper that keeps JSON objects as objects |
| `stdClass` cannot hold a key that starts with a NUL byte | `JObject` does not use `stdClass` |
| `json_encode` prints `1.0` as `1.0` and large doubles in exponent form that differs from JavaScript | `Json::numberText`, the shortest round-trip text JavaScript would print |
| `$_GET` keeps the last repeated query parameter, the other stacks keep the first | the query string is parsed directly (`Request::status`, `Request::siteId`) |
| `strlen` counts bytes; the spec counts UTF-16 code units | `Json::utf16Length`, `Json::compactLength` |
| `trim()` strips ASCII whitespace and NUL only; JavaScript also strips NBSP, `U+FEFF`, `U+2028` and more (and keeps `U+0085`) | `Json::trim` uses the JavaScript set |
| `rawurldecode` leaves a malformed escape such as `%zz` in place | `Request::decodeSegment` refuses it with 400 |
| An old row can hold a value the stricter parser would now refuse (a 20-digit number) | `Json::parseStored` is lenient; only requests are strict |

## Tests

`php ports/php/core/test/notify.php` runs the notification rules against the real `ApprovalService` and an in-memory store
(26 checks, no phpunit needed). There are no other PHP unit tests yet. The core is exercised end to end by the WordPress
plugin: the conformance suite, the 98-request differential probe and the fuzzer against the other stacks, and the WordPress
scenarios. A phpunit suite for `Json` and `Guard` is the next thing to add.
