# Contributing

The most useful contributions are another stack that passes the conformance suite, a hostile request that two stacks
answer differently, and fixes to the review page.

## Run the checks

```
npm test                                      # Node reference, review-page helpers, 15+ faulty-server mutants (no install needed)
php ports/php/core/test/notify.php            # PHP core
php ports/php/core/test/request.php
dotnet test ports/dotnet.tests                # .NET port on an in-memory store
node conformance/run.mjs --config conformance/profiles/demo-cms.json   # against a running demo CMS (npm start)
```

Node 18 or newer, PHP 8.1 or newer, .NET 8. There is nothing to `npm install`.

## Rules of thumb

* The Node code in `src/server/` is the reference and [docs/spec.md](docs/spec.md) is the contract. A change to behavior
  changes the spec, the reference, every port and the conformance suite together.
* A new check or port is done when the suite passes against it and the differential probe shows no disagreement
  with the other stacks ([conformance/README.md](conformance/README.md)).
* Every bug fix adds a test that fails without it; for a rule the suite should catch, add a mutant to
  `test/e2e/conformance.test.mjs`.
* Keep keys, `*.local.json` files and `.env` files out of commits.
