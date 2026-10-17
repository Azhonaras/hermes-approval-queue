# Architecture

This document describes how an AI agent writes to your CMS without sharing the CMS login
and without being able to approve its own change. The CMS stack is yours. What this document
defines is the shared object and the guard.

![Two doors, one approval row](../assets/architecture.svg)

The agent never opens the CMS, and the manager never holds the agent's keys.
The only shared object is the approval row: resource, action, scope,
immutable JSON, status, expiry, and who decided.

## End-to-end flow

```mermaid
sequenceDiagram
    autonumber
    participant Agent
    participant Api as Your API
    participant Row as Approval row
    participant Page as Review page
    participant Manager

    Agent->>Api: POST /proposals
    Note over Api: size, action, and scope checks
    Api->>Row: insert Pending and store JSON
    Api-->>Agent: id and status Pending

    Manager->>Page: open queue
    Page->>Row: list Pending
    Page-->>Manager: cards and exact JSON
    Manager->>Page: approve, reject, or request changes
    Page->>Row: Pending becomes Approved
    Note over Page,Row: decidedBy is the session user

    Agent->>Api: GET /proposals/id
    Api-->>Agent: Approved

    Agent->>Api: POST /writes
    Api->>Row: bind and consume
    Api->>Api: your save and audit
    alt write fails
        Api->>Row: roll back to Approved
    end
    Api-->>Agent: 200 Consumed
```

Chat is not a step. The approve action in the CMS is the only confirmation. After
`Approved`, the agent executes that same write once.

The `GET /proposals/id` in step 11 can be triggered by a doorbell instead of a poll. A CMS may POST a four-field notification (id,
new status, time) to a receiver its operator configured, after the decision is stored and the reviewer has been answered.
The notification carries no content and no authority. The agent still reads the row and redeems it through its own key
([spec](spec.md#decision-notifications-optional)).

```mermaid
sequenceDiagram
    autonumber
    participant Manager
    participant Page as Review page
    participant Api as Your API
    participant Hook as Agent's receiver
    participant Agent

    Manager->>Page: approve
    Page->>Api: POST /proposals/id/approve
    Api->>Api: store Approved
    Api-->>Page: 200
    Api-)Hook: {"event":"decision","approvalId":1042,"status":"Approved",...}
    Hook-)Agent: wake up
    Agent->>Api: GET /proposals/id (own key)
    Agent->>Api: POST /writes (same JSON)
```

## Two trust domains

```mermaid
flowchart LR
    subgraph agent["Agent"]
        direction TB
        A1["read + write keys"]
        A2["cannot approve"]
        A3["propose / poll / write"]
    end
    subgraph row["Approval row"]
        direction TB
        R1["resource, action, scope"]
        R2["immutable JSON"]
        R3["consume once + rollback"]
    end
    subgraph cms["Manager"]
        direction TB
        C1["CMS session"]
        C2["no API key on the page"]
        C3["approve / reject / changes"]
    end
    agent --> row
    cms --> row
```

## Layers (you map these to your code)

```mermaid
flowchart TB
    subgraph agentDoor["Agent door"]
        direction TB
        Agent["AI agent"] --> API["HTTP API"]
        API --> Guard["Approval guard"]
    end
    subgraph managerDoor["Manager door"]
        direction TB
        Manager["Manager"] --> Page["Review page"]
        Page --> App["Application services"]
    end
    Guard --> Store[("Approval row")]
    App --> Store
    Guard --> Write["Write path"]
    Write --> Save["Your CMS save + audit"]
```

| Piece | What it does |
| --- | --- |
| HTTP API | TLS, rate limit, scoped keys, proposals, writes |
| Approval guard | Status, expiry, resource match, JSON equality, consume-once |
| Application services | Submit, decide, expire pending, history |
| Store | Conditional update for decide and consume (no lost update) |
| Review page | Your login / roles, card queue, history, confirm dialogs |
| Write path | Apply approved fields through **your** CMS save, audit |

The page lives inside the CMS (same login and roles). The API can live
on the same site so there is one TLS door.

## Approval as a capability

An approval works like a capability token more than like a ticket.

- It names one resource (`article/42`), one action (`update:canonical`
  or whatever verb you defined), one scope.
- It stores the exact JSON the manager saw.
- It is minted as `Pending`, becomes `Approved` only from a human
  session, and is destroyed (`Consumed`) by the first matching write.
- A different body, even on the same resource, is `409`. The agent must
  submit a new proposal.

If the guard only checked "this id was approved for this page," the
agent could show a harmless title change and redeem a destructive
canonical. Binding the payload is what makes the review meaningful.

### Why actions are not generic

`update` is not an action. Each write path needs its own verb. Endpoints
often share a resource type, so a vague action would let one approval
unlock another endpoint.

Deletes may carry no body. The guard then binds resource + action +
scope only.

Proposals are capped (field count and serialized length) because a
human has to read them. An unreviewably large payload is refused at
submit time.

The SEO verbs in the demo CMS (`update:onpage`, `update:canonical`, …)
are an example profile. See [spec.md](spec.md).

## State machine

```mermaid
stateDiagram-v2
    direction TB
    [*] --> Pending: submit
    Pending --> Approved: approve
    Pending --> Rejected: reject
    Pending --> ChangesRequested: request changes
    Pending --> Expired: clock
    Approved --> Consumed: matching write
    Approved --> Expired: clock
    Approved --> Approved: write failed
    ChangesRequested --> Pending: new id
    Consumed --> [*]
    Rejected --> [*]
    Expired --> [*]
```

The parent row stays immutable. A revision is a new `Pending` id.

`Approved` is not terminal. Between the manager's click and the agent's
write, the row is waiting. History lists Rejected, Consumed, Changes
requested, Approved (waiting), and Expired, so a ticket stays visible
in that gap.

## Guard on the write path

```mermaid
flowchart TD
    Start["POST /writes + approvalId"] --> Load["Load row"]
    Load --> St{"Status"}
    St -->|"Pending"| E1["409 not approved yet"]
    St -->|"not Approved"| E2["409 not usable"]
    St -->|"Approved"| Exp{"Expired"}
    Exp -->|yes| E3["409 expired"]
    Exp -->|no| Match{"Fields match"}
    Match -->|no| E4["409 mismatch"]
    Match -->|yes| Json{"JSON equals body"}
    Json -->|no| E5["409 payload mismatch"]
    Json -->|yes| Claim["Consume if still Approved"]
    Claim -->|"0 rows"| E6["409 already used"]
    Claim -->|"1 row"| Apply["Your save + audit"]
    Apply -->|ok| Ok["200 Consumed"]
    Apply -->|fail| Back["Roll back to Approved"]
```

Claim, mutation, and audit run in one transaction. Two concurrent
writes still have one winner. A failed write restores `Approved`.

## After a successful write

If your API caches read models, drop the keys the write just changed.
The agent must not read a stale cache hit as a failed write.

## Intentional non-features

- No apply-on-approve on the server. Approve records intent, and the
  agent still writes, so consume and audit stay on the same path.
- No decide key in the agent. Chat cannot approve.
- No second confirmation after the CMS click. The page is the
  confirmation.
- No content in a notification, and no agent-chosen receiver. The doorbell
  names the approval and its new state and nothing else, and only the CMS's
  operator can say where it rings.
