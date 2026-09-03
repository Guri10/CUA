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
| `member-lookup` | read-only | `by` (`number` \| `name`), `q` | `member` `{ number, name }` **or** `candidates[]` | success = member record; `NOT_FOUND`; `MULTIPLE_MATCHES` (candidate list) |
| `member-balance` | read-only | `memberNumber` | `shares[]` `{ shareId, type, balance, status }` | success = member record; `NOT_FOUND` |
| `funds-transfer` | mutating | `memberNumber`, `fromShare`, `toShare`, `amount`, `memo?` | `confirmationNumber`, `posted` | success = post confirmation; `SOURCE_ON_HOLD`, `INSUFFICIENT_FUNDS`, `NOT_FOUND` |
| `open-share` | mutating | `memberNumber`, `shareType`, `initialDeposit` | `newShareId`, `confirmationNumber` | success = confirmation; `NOT_FOUND` (deposit/validation rejections discovered while recording) |
| `update-member` | mutating (single-step, no review) | `memberNumber`, `email?`, `phone?`, `address?` | updated fields (acknowledgement) | success = updated record; `INVALID_EMAIL`, `INVALID_PHONE`, `NOT_FOUND` |
| `place-hold` | mutating (supervisor-gated at review) | `memberNumber`, `shareId`, `reasonCode` (`FRAUD` \| `LEGAL` \| `DECEASED`), `notes?` | `confirmationNumber` | success = confirmation; `SUPERVISOR_OVERRIDE_REQUIRED` (`403`), `NOT_FOUND` |

## Exposure

Capabilities are served over the existing catalog (`GET /capabilities`, `POST
/capabilities/:ref/invoke`), **approved-only** — drafts are authoring artifacts, invisible to the
agent. Each invoke is self-contained (sign on → run → close) and returns the same discriminated
result a direct Replay does; an escalation surfaces as a terminal `escalated` status with context,
not a live-browser handoff (that stays CLI/authoring-side).
