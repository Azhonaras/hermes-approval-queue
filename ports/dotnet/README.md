# .NET 8 port (ASP.NET Core + SQL Server)

Same contract as `docs/spec.md`, same layers as `src/server/`:

```
Http/ApprovalEndpoints.cs  route table, JSON envelope, body cap (200,000 bytes), percent-decoding of path segments
Http/Doors.cs              IDoors: who is calling (demo: static keys + a header; production: context.User)
Core/                      Validation, Guard, Canonical, StrictJson, JsNumber, ApprovalService (no I/O)
Store/SqlServerStore.cs    conditional UPDATE ... OUTPUT; ConsumeAsync = claim + apply + audit in ONE transaction
Cms/SqlCmsAdapter.cs       demo content in a table; replace with calls into your own save code
```

## Run

```bash
export HERMES_DB='Server=localhost;Database=hermes;User Id=sa;Password=...;TrustServerCertificate=True'
export HERMES_READ_KEYS=demo-read HERMES_WRITE_KEYS=demo-write
export HERMES_REVIEW_SESSIONS=demo-manager=manager.demo      # demo only
export HERMES_BASE_PATH=/api/seo HERMES_SEED=1 HERMES_URLS=http://127.0.0.1:8791
dotnet run
node ../../conformance/run.mjs --config ../../conformance/profiles/dotnet-sqlserver.json
```

`HERMES_SEED=1` creates the tables and the demo content. Leave it off against a real database.

To tell the agent when a person decides instead of making it poll, the operator sets `HERMES_WEBHOOK_URL` and, to sign the
notifications, `HERMES_WEBHOOK_SECRET`. `WebhookNotifier` then posts `{"event":"decision",...}` after each stored decision
without making the reviewer wait: once, 3 seconds at most, no retry, redirects not followed, failures logged and swallowed. A
URL that is not plain `http(s)` without credentials stops the start. See [the spec](../../docs/spec.md#decision-notifications-optional).

## Plug in your CMS

1. Reviewer door: implement `IDoors.Reviewer` from your login (`context.User.IsInRole("Manager")`), never from anything the agent holds.
2. CMS adapter: implement `ICmsAdapter.ReadAsync` and `ApplyAsync`. `ApplyAsync` receives the open `SqlTransaction`:
   use it for your writes, and throw to refuse. The claim, your change and the audit row then commit or roll back together.
3. Profile: replace `Profile.Seo()` with your actions and scopes.

## Tests

`dotnet test ../dotnet.tests` always runs the notification tests (no database: the service runs on an in-memory store and the
sender talks to a local listener). The in-memory store is for tests and for `MemoryHost` only; it proves the HTTP layer, the
rules and the notifier, not SQL transactions. `dotnet run --project ../dotnet.tests/MemoryHost` serves the API on port 8791
with the demo keys, so `node ../../conformance/run.mjs --config ../../conformance/profiles/dotnet-sqlserver.json` works without
SQL Server (add `HERMES_WEBHOOK_URL`/`HERMES_WEBHOOK_SECRET` and `--notify-port`/`--notify-secret` for the `notify` group).

To run the database tests, run `dotnet test ../dotnet.tests` with `HERMES_TEST_DB` pointing at an empty, disposable
database. Without it the three tests are reported as skipped (a mock would not prove transaction behaviour). They check
three things: a write that fails after changing content rolls back the claim and the content, then succeeds on retry;
12 parallel claims apply exactly once; a failed write leaves no audit row.
