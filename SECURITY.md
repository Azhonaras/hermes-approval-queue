# Security

This project sits between an AI agent and a CMS and exists to keep the agent from approving its own requests.
The rules that enforce this are in [docs/security.md](docs/security.md), and the strict input contract is in
[docs/spec.md](docs/spec.md). The conformance suite and the mutant tests check both.

## Reporting a vulnerability

Please do not open a public issue for a security problem. Use GitHub's private vulnerability reporting for this repository
(Security tab, "Report a vulnerability"). Say what you did, what you expected and what happened. A failing
conformance check or a request/response pair helps most.

Reports we most want: any way for the write key or agent-supplied text to approve, edit or consume a request; a payload
that executes differently from what the reviewer saw; and any request on which two stacks answer differently.

## Using it safely

* Keep the notification URL and secret in the CMS operator's configuration, never in anything the agent can change.
* Serve the review page only to signed-in managers; never reuse the agent's key there.
* The demo CMS uses dummy keys and open CORS for local use only. Do not expose it to a network.
