# UI

The review screen belongs inside your CMS, where managers already know the
chrome. The demo is RTL Persian; your locale can differ. The approval dialog
shows the exact JSON again, so the final check cannot skip it.

## Layout

```
┌ header ──────────────────────────────── lock: agent cannot approve ─┐
│  Human decision queue                                               │
│  Requests waiting for approval                                      │
├ pending ────────── routine ────────── needs review ─────────────────┤
├ [ Queue ]  [ History ] ─────────────────────────────────────────────┤
│                                                                     │
│  select all   risk filter                     reload   collapse     │
│                                                                     │
│  ┌ card HRM-1042 ──────────────────────────────── [needs review] ─┐ │
│  │  AI   Update canonical · article/42                            │ │
│  │       agent reason · expiry                                    │ │
│  │       [ + exact payload ]                                      │ │
│  └────────────────────────────────────────────────────────────────┘ │
│                                                                     │
├ sticky  2 selected ──────────────── [changes] [reject] [approve] ───┤
└─────────────────────────────────────────────────────────────────────┘
```

Width stays around 1120px so a card is readable. The action bar sticks
to the bottom of the queue, so Approve stays in view on a long list.

## Visual language

| Token | Role |
| --- | --- |
| Paper `#f5f5f3` / white | Quiet CMS surface |
| Ink / muted gray | Long Persian lines |
| Gold | Waiting / pending |
| Green `#176b45` | Approve, lock, consumed |
| Red `#a63131` | Reject |
| Amber | Needs review, expired, revision |
| Blue-gray | Request-changes, details |

Type: IRANSans, Tahoma, Arial. Technical values (`HRM-1042`,
`update:canonical`, JSON) are left-to-right inside RTL sentences.

## Cards instead of a grid

A row grid hides the reason and the payload, so the card is the unit of
review:

1. Who (AI) and which ticket (`HRM-n`)
2. What will happen
3. Resource / action / site
4. The agent's reason
5. Revision banner if this row replaces a "please fix" parent
6. Collapsed exact JSON

Risk is derived from the action, not from the agent. Canonical,
redirect, delete, and merge need careful review. Title and description
updates are routine. The filter is client-side.

Select-all is a `type="button"` with `aria-pressed` instead of a checkbox
inside the CMS form, because those look dead. Partial selection is a
half-filled box.

## Dialogs

| Action | Extra friction |
| --- | --- |
| Approve | Show exact request; tick "I reviewed resource, action, payload, reason, scope" |
| Reject | Written reason |
| Request changes | Written feedback; parent stays immutable |

Validate in JavaScript. Native `required` on fields inside a large
CMS `<form>` can block the real submit.

## History

Same page, second tab. It lists finished rows, including approved rows that
are not yet consumed, with a status filter and search. The payload stays behind `<details>`.

44px targets, labelled dialogs, focus rings, live status for server
messages. Mobile stacks the fact grid and the three actions.

See the [demo](../demo/index.html).
