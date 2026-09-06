# MERIDIAN adaptation — write-up

This is the adaptation write-up. The core is the discover → record a Capability → deterministic
replay engine from the take-home ([`REPORT.md`](REPORT.md)); this document is only what changed to
point it at MERIDIAN CORE (`web-sample.interface-hiring.com`) and wrap it in an API, a chatbot, and
a dashboard. Reasoning lives here; the decisions are backed by the ADRs in [`docs/adr/`](docs/adr/)
and the vocabulary is in [`CONTEXT.md`](CONTEXT.md).

All seven functions from the brief's §2.1 are recorded, approved, and replayable: `sign-on`,
`member-lookup`, `member-balance`, `funds-transfer`, `open-share`, `update-member`, `place-hold`
(each `capabilities/<id>/2.json`, all `approval: approved`). The suite is green — 568 tests across
66 files, no browser. The whole adaptation is one branch, +16,010 / −229 lines: overwhelmingly new
code beside the core, not rewritten core.

## What adapting took — and what in the core I had to change

Most of the adaptation was configuration and new recordings, exactly as the brief hoped. A new
Surface is one JSON profile (`surfaces/meridian.json`, 46 lines: allowed origin, the route
allowlist split read-only vs mutating, and the recoverable-condition predicates) plus seven
capability modules. The Surface interface, replay engine, policy gate, redaction, and escalation
code are surface-agnostic and were reused unchanged.

Four things in the core did have to move. I list them because "where it wasn't config" is the
honest signal the brief asks for:

- **Route matching by pattern, not literal** (ADR 0009). ParaBank's routes are flat
  (`/transfer.htm`); MERIDIAN's carry the member number (`/members/100234/transfer/post`). A member
  id is data, not a route, so I taught the gate that a `:id` segment matches any one segment and the
  read/mutate class comes from the verb segments around it. Flat profiles still match by equality, so
  ParaBank is untouched — the change is additive.
- **A `readEach` verb for tables** (ADR 0010). A plain `read` addresses one control and treats
  several matches as a miss, on purpose. But `member-balance` returns a member's shares, and the
  count isn't known when the Recording is written. `readEach` iterates rows and reads each column
  *within its row*, binding a list output. Plain `read` is left exactly as it was.
- **One perceived tree for both acting and checking** (ADR 0011). This was the deepest change, and
  it was forced by MERIDIAN's legacy `<tr><td>` markup. Actions used to resolve through Playwright's
  `getByRole` while Checkpoints resolved through the parsed accessibility snapshot — two different
  "find this control" lenses that compute an accessible name two different ways. On MERIDIAN's member
  record a wrapper cell's name concatenates the whole row, so the two lenses disagreed: a read landed
  on the right value live but the Checkpoint (and every unit test) passed against the clean tree.
  I retired the second lens; everything now resolves against the one snapshot, so the fake Surface
  can no longer pass while the live page fails.
- **Somewhere to hold the operator password**. MERIDIAN signs on per operator, and the password must
  never enter an API payload, the chatbot, or evidence. So there's a small in-memory secret store
  (dropped on exit), a one-screen sign-on portal to load it, and a hidden prompt for direct CLI runs.
  The password is classified Secret (ADR 0006) and is never written anywhere.

Two discovery-engine tweaks also came out of recording the mutating flows attended (snapshot the
final form state at handover; let a blank optional input pass the unused-input guard). Neither
touches replay.

## Exposing the Capabilities as an API

The catalog is `npm run serve` → an HTTP service on `127.0.0.1:8788`, loopback only (an invoke
drives a real browser and signs in, so the caller is assumed to be on the same machine). Two routes:

- `GET /capabilities` — every **approved** Capability, highest version, with its full Contract
  (summary, typed input/output JSON Schema, declared effects, terminal states). Drafts are invisible
  to the agent, and the Recording — the "how" — is deliberately not published.
- `POST /capabilities/:ref/invoke` — runs one by name with typed args and returns how it ended.

Under the hood an invoke is the exact machinery a CLI `replay` runs: open an evidence run → open the
gated, logged browser Surface → sign on → replay with no model in the loop → close, leaving the same
evidence trail. The response is a discriminated result whose HTTP status echoes the outcome:

| Outcome | Status | Body |
| --- | --- | --- |
| Success | 200 | `{ kind: "success", outputs: {…} }` |
| Business Outcome | 200 | `{ kind: "business-outcome", name, step }` |
| Hard Failure | 502 | `{ kind: "hard-failure", step, expected, observed, url }` |
| Escalated (pre-run gate refusal) | 403 | `{ kind: "escalated", context: {…} }` |
| Invalid inputs / no such Capability | 400 / 404 | `{ error }` |

A Success or a named Business Outcome is a 200 the way a passing task is exit 0 — "no such member"
is the answer the application gave, not a crash. Two guarantees run *before a browser exists*: a
mutating Capability that isn't approved is refused, and inputs that don't match the Contract are
rejected.

**The chatbot** (`:8790`) is a thin driver over that API, standing in for the calling agent. The
only non-deterministic point is an intent router — one Claude call per turn, forced to exactly one
tool (`invoke_capability`, `ask_user`, or `finish`) — that maps language to a capability ref plus
typed inputs. It loops up to six steps, feeding each result back as history, so "resolve the member,
then act on them" emerges from the loop rather than a plan; the second turn holds the number the
first returned. It stops on the first non-success outcome (you can't transfer from a `NOT_FOUND`
member) and reports in plain language, never leaking a screen or URL. Mutating actions are previewed
and confirmed first. The chatbot holds no guardrail of its own — that stays the catalog's.

One gap surfaced in testing and is worth calling out, because it shows where the boundary sits. A
request that named a share only by *type* — "transfer from member 100234's Regular Shares" — is
under-specified when the member holds twenty of them, and the router would quietly pick one and post
an irreversible transfer. The policy gate cannot catch this: it decides *whether* a mutating
Capability may run, not *which* record it acts on, and the share it picked was a valid input. So the
fix belongs at the chatbot — the layer that turns language into inputs. The router has a third move,
`ask_user`, and is instructed that when a load-bearing input on a *mutating* Capability is not pinned
to a single value it must look first (invoke the read-only balance list) and then ask, never guess.
The loop stops on an ask and invokes nothing further, so no money moves on a guessed share; a
read-only request never asks, because resolving a member is always safe. The plumbing is
deterministic and tested; whether the model *chooses* to ask on an ambiguous request is prompt-driven
— the same model-compliance caveat as any router decision.

**The dashboard** (`:8789`) is read-only (any non-GET is a 405; it invokes nothing). It
server-renders the approved catalog and the run history read straight from the evidence `run.jsonl`
files: each run's status, capability, inputs, output count, and an evidence line with the action
count and a failure-screenshot link. `npm run serve` boots all of these, plus the MERIDIAN sign-on
portal on `:8791`.

## Driving the legacy UI, and its exceptional states

Two things make replay reliable on this surface. Controls are addressed by accessibility role and
name only — never CSS or XPath (ADR 0001) — so a layout change is shrugged off and a renamed control
fails loudly instead of clicking the wrong thing. And the per-transaction hidden token is **never
read**: the mutating flows walk form → review → post, and the click on "Post Transfer" / "Apply
Hold" submits the form so the browser carries the token natively. There's an e2e test asserting no
recording ever reads it.

The exceptional states are the load-bearing part, and the key design choice is that **HTTP status is
never inspected — each condition is recognised by the screen it produces**, in three classes at three
scopes (ADR 0005):

| Injected fault | Recognised as | Class / where it lives |
| --- | --- | --- |
| `validation` 400 | `INSUFFICIENT_FUNDS`, `SOURCE_ON_HOLD`, `INVALID_EMAIL`/`INVALID_PHONE`, `MINIMUM_DEPOSIT` | Business Outcome — the **Capability** |
| `notfound` 404 | `NOT_FOUND` (also `MULTIPLE_MATCHES`) | Business Outcome — the **Capability** |
| `permission` 403 | `SUPERVISOR_OVERRIDE_REQUIRED` | Business Outcome — the **Capability** |
| `timeout` 440 | `SESSION_EXPIRED` → re-establish once | Recoverable Condition — the **Surface** |
| `maintenance` 503 | `MAINTENANCE` → retry once | Recoverable Condition — the **Surface** |
| `server` 500 | matches no predicate | **Hard Failure** — leftover |

A Business Outcome belongs to a single Capability, because only `member-lookup` knows what its own
not-found screen looks like. A Recoverable Condition belongs to the Surface, because a session
expiring is a fact about MERIDIAN, not about any one flow — replay absorbs it and re-runs from step
one, bounded to once per condition (a second occurrence is a loop, not a recovery, and escalates).
A mutating Capability is *never* recovered by re-run, since running a transfer twice moves money
twice. Anything that matches nothing is a Hard Failure that names the step, what it expected, and
what it saw — the safe direction to be wrong in. The supervisor `403` is deliberately a reported
Business Outcome, not a role check we perform: authorization is the target's to answer (ADR 0008),
so a teller attempting Place Hold gets a clean `SUPERVISOR_OVERRIDE_REQUIRED`.

## Safety, evidence, and escalation through the new surface

The guardrails are unchanged because the wrapper calls the same core, not around it. Every action
from both discovery and replay passes through one policy gate decorating the Surface — there is no
unwrapped surface to reach, and a test enforces that. It's a deny-by-default allowlist: unknown
origin, route, or verb is refused. Whether a run may mutate at all is decided from two declared
fields — a Capability's effects and its approval — *before a browser opens*, so an unapproved
mutating Capability never reaches a screen. The model never labels its own actions as safe. Place
Hold is mutating and approved, so it runs, but is never silently replayed on recovery. Redaction is
by kind: the password and session token are Secret and never written (no flag turns that off); names
and balances are Sensitive — masked in stored evidence but returned to the caller in full, because
reading the balance is the whole point.

Escalation survives as two distinct paths. Over the API and chatbot there's no browser to hand a
person, so a pre-run gate refusal surfaces as a terminal `escalated` status (HTTP 403) carrying the
Capability, where it stopped, and why — reported cleanly, with nothing having happened. The CLI
attended path keeps the full live-browser handoff: control transfers to a human (exactly one
controller at a time), a loopback resume endpoint hands it back, and the person's steps fold into the
Recording. The demoable escalation for MERIDIAN is the terminal `escalated` 403 over the catalog.

## What I left out, and would do next

- **Committed live runs.** The exceptional states are captured as real accessibility-tree snapshots
  (`evidence/accessibility-tree/meridian/` — every outcome screen, plus the injected fault screens),
  and the flows are covered by unit and live e2e tests, but the committed `evidence/runs/` are still
  mostly ParaBank. Next: capture and commit one live MERIDIAN replay per capability as durable
  evidence for a reviewer to browse in the dashboard.
- **The volatile share label.** MERIDIAN's share dropdown options embed the live balance in their
  accessible name (`100234-MMKT-22 - Money Market ($25.00)`), which drifts with every transfer. Under
  ADR 0001 the only handle is that name, so a bound value can't stay stable. The caller passes the
  current label per invocation (re-read via `member-balance` first). The real fix is the target's (a
  stable option name) or a relaxation of ADR 0001 (reaching for the DOM `<option value>`), which I
  rejected. Documented in `docs/meridian-capabilities.md`.
- **Partial member updates.** `update-member` writes e-mail, phone, and mailing address as a single
  form — there is no partial update. When a request names only some of them, the chatbot asks for the
  rest rather than guessing (the same look-then-ask move as the ambiguous-share case), which is the
  safe direction. But a request to change one field and "keep the rest the same" cannot be honoured,
  because no read-only Capability returns a member's current contact record — `member-lookup` gives
  the number and name, `member-balance` gives the shares, and neither reads the e-mail, phone, or
  address. So today the caller has to restate all three. The fix is a read that returns the current
  contact fields (a `member-contact` Capability) for the chatbot to pre-fill the unchanged ones, or an
  update that accepts a partial patch; the former keeps the whole-form Recording intact.
- **Reach.** No second tenant variant (the per-step override mechanism is built and tested, just not
  exercised with a branded profile). Catalog, chatbot, and dashboard are loopback-only with no auth.
  Escalation over the API is terminal rather than a remote live handoff.

**Demo path:** fill `.env` (teller + supervisor operators, branch, `ANTHROPIC_API_KEY`,
`CHATBOT_API_KEY`), then `npm run serve` and drive from the chatbot (`:8790`) while watching the
dashboard (`:8789`) — a balance check and a posted transfer for the happy path, a teller Place Hold
for a clean `SUPERVISOR_OVERRIDE_REQUIRED`, and a mutating draft for a terminal escalation. The
step-by-step re-drive, including the live-data gotchas, is in `docs/meridian-redrive-runbook.md`.
