# MERIDIAN Core — capability spec (design)

The capabilities to record against MERIDIAN Core (`web-sample.interface-hiring.com`), Surface id
`meridian`. One atomic Capability per function in the brief's §2.1; the chatbot chains them (resolve
a member, then act). This is the design agreed during grilling, not the built artifacts — exact
enum option values and any further Business Outcomes are confirmed while recording.

## Cross-cutting

- **Sign-on runs ahead of every invoke** as surface-level session establishment (the ParaBank
  `establishSession` pattern), and also exists as a recorded Capability for §2.1 coverage. The
  Operator password is supplied from server-side config keyed by a non-secret operator id the
  caller passes; it never enters the chatbot or the API payload, and is classified Secret (ADR
  0006), so it is never written to evidence.
- **Mutating flows walk form → review → post.** The per-transaction hidden `_token` rides the
  browser's native form submit and is never read (ADR 0001 holds unchanged).
- **Authorization is the target's** (ADR 0008): a `403` "supervisor override required" is the
  Business Outcome `SUPERVISOR_OVERRIDE_REQUIRED`, not a role check we perform.
- **Recoverable Conditions** live in `surfaces/meridian.json`: `SESSION_EXPIRED` (`440` "Session
  Ended" → re-establish once) and `MAINTENANCE` (`503` → retry once); a second consecutive
  occurrence escalates rather than looping. `500` and any unrecognised screen are Hard Failures
  (fail loudly — no catch-all bucket).
- **Effects** gate at the policy layer (ADR 0007); routes match by path pattern (ADR 0009).

## Capabilities

| Capability | Effects | Inputs (typed) | Outputs (typed) | Terminal states |
|---|---|---|---|---|
| `sign-on` | session | `operator` (non-secret id), `password` (Secret, server-side), `branch` (`MAIN-001` \| `WEST-014` \| `EAST-022`) | `operatorRole` (target's assertion, e.g. `TELLER`/`SUPERVISOR`), `signedOn` | success = menu banner "Signed on as …"; `BAD_LOGIN` |
| `member-lookup` | read-only | `by` (`Member Number` \| `Last Name`), `q` | `memberNumber`, `name` (on success) | success = member record; `NOT_FOUND`; `MULTIPLE_MATCHES` (caller narrows the search) |
| `member-balance` | read-only | `memberNumber` | `shares[]` `{ shareId, type, balance, status }` | success = member record; `NOT_FOUND` |
| `funds-transfer` | mutating | `memberNumber`, `fromShare`, `toShare`, `amount`, `memo?` | `confirmationNumber`, `posted` | success = post confirmation; `SOURCE_ON_HOLD`, `INSUFFICIENT_FUNDS`, `NOT_FOUND` |
| `open-share` | mutating | `memberNumber`, `shareType`, `initialDeposit` | `newShareId`, `confirmationNumber` | success = confirmation; `NOT_FOUND` (deposit/validation rejections discovered while recording) |
| `update-member` | mutating (single-step, no review) | `memberNumber`, `email?`, `phone?`, `address?` | updated fields (acknowledgement) | success = updated record; `INVALID_EMAIL`, `INVALID_PHONE`, `NOT_FOUND` |
| `place-hold` | mutating (supervisor-gated at review) | `memberNumber`, `shareId`, `reasonCode` (`FRAUD` \| `LEGAL` \| `DECEASED`), `notes?` | `confirmationNumber` | success = confirmation; `SUPERVISOR_OVERRIDE_REQUIRED` (`403`), `NOT_FOUND` |

## Parameterising a control with a volatile label (share dropdowns)

`funds-transfer` (`fromShare`, `toShare`) and `place-hold` (`shareId`) each select a
share from a dropdown, and **the caller must pass the current option label**, not a
bare share id. This is a modelling limit, not a binding bug, and a failed `select`
on replay is expected rather than a regression.

Why: discovery parameterises a Step by **whole-value equality** (`expressionFor`,
`src/discovery/record.ts`) — a `select` binds to an input only when the captured
option label exactly equals the declared input value. Under ADR 0001 the only
handle for a control is its **accessible name**, and MERIDIAN gives each share
option an accessible name that embeds the live balance, e.g.
`100234-MMKT-22 - Money Market ($25.00)`. That balance drifts with every transfer
or hold, so the label is not a stable identifier:

- At **record** time the label may not equal the `--input` share string, so the
  Step does not bind to the input.
- At **replay** time the label has changed since it was recorded, so a bound value
  no longer matches any option and the `select` misses.

Workaround (what the hand-written capabilities do): **the caller supplies the
current label per invocation.** Re-read the live labels first —
`npm run replay -- --capability member-balance --input memberNumber=<n>` lists each
share's current `{ shareId, type, balance, status }` — then pass the whole current
option string as the share input. Pick an `OPEN` share; a held one as a transfer
source returns `SOURCE_ON_HOLD`.

The two real fixes are both out of our hands or out of scope:

- **A stable option accessible name** (e.g. the label without the balance) would
  make the option parameterisable, but that is a change to the target, not to us.
- **Relaxing ADR 0001 to address the underlying `<option value>` id** would give a
  stable handle, but reaching past the accessibility tree for a CSS/DOM id is
  exactly what ADR 0001 forbids — rejected.

Related discovery-engine work that came out of the same #46 investigation but does
**not** remove this limit: capturing a default option left unchanged at handover
(#48) and letting a blank optional input pass the unused-input guard (#49). Both
help attended mutating runs record and save; neither makes a drifting label stable.

## Exposure

Capabilities are served over the existing catalog (`GET /capabilities`, `POST
/capabilities/:ref/invoke`), **approved-only** — drafts are authoring artifacts, invisible to the
agent. Each invoke is self-contained (sign on → run → close) and returns the same discriminated
result a direct Replay does; an escalation surfaces as a terminal `escalated` status with context,
not a live-browser handoff (that stays CLI/authoring-side).
