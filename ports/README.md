# Ports

The Node code in `src/server/` is the reference. These ports implement the same
[contract](../docs/spec.md) on other stacks and are held to it by the same
[conformance suite](../conformance/README.md). A port is done when the suite passes against it.

| Folder | Stack | Store | Reviewer door |
| --- | --- | --- | --- |
| [`dotnet/`](dotnet/) | .NET 8, ASP.NET Core | SQL Server (claim + write in one transaction) | `IDoors` (plug in `context.User`) |
| [`dotnet.tests/`](dotnet.tests/) | xUnit: unit tests of the notifier and service on an in-memory store; store tests against a real SQL Server when `HERMES_TEST_DB` is set. `MemoryHost/` runs the .NET HTTP layer on that in-memory store so the conformance suite can run without SQL Server | | |
| [`php/core/`](php/core/README.md) | PHP 8.1+, no framework: rules, state machine, strict JSON, guard | bring your own `ApprovalStore` | bring your own |
| [`php/wordpress/`](php/wordpress/README.md) | WordPress plugin on top of the PHP core (MySQL/MariaDB and SQLite, including Playground) | `$wpdb`, InnoDB transaction | WordPress users: cookie + nonce (the review page under **Agent requests** in wp-admin), or an Application Password |

Each port keeps the same layers as the Node reference, so what you learn in one applies to the others:

```
doors (who is calling)  ->  routes (method + path)  ->  service (use cases)
        core rules (validation, guard, canonical JSON, strict JSON)
        store (conditional transition, claim + apply in one transaction)
        CMS adapter (read, apply: the only code that touches your content)
```

## What "tested" means here

* The full conformance suite (75 checks, plus the 9 optional `notify` checks), run on a real database rather than a mock (SQL Server, MariaDB, SQLite).
* The differential probe (98 hostile requests) and the differential fuzzer (thousands of generated requests), run against all ports at once. They must show no disagreement.
* Store-level tests for what HTTP cannot reach: a failed write rolls back the claim and the content.

Run them from the repository root; the profiles in `conformance/profiles/` point at the ports' default ports.
