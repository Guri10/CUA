# Report

Learn how to drive a legacy application once with a model, then replay it deterministically with no
model in the loop. Built against ParaBank — Parasoft's self-hosted demo bank, a real server-rendered
Java app with old markup and no test IDs, chosen so the targeting problem is genuine rather than
staged. The decisions below are recorded as ADRs under [`docs/adr/`](docs/adr/); the vocabulary is in
[`CONTEXT.md`](CONTEXT.md). This report gives the reasoning, not the code.

## Architecture

Two phases across one seam. A **Discovery Run** puts a model on the live application to observe,
decide, and act until a goal is met; a **Replay** re-runs what that produced with no model in the
decision loop. The one thing that crosses between them is a **Capability** — a named, versioned,
agent-invocable unit holding a declared Contract and one or more Recordings. Three commands expose the
system: `discover`, `replay`, and `serve` (a catalog an agent invokes over HTTP).

Discovery runs on `claude-opus-5` (Anthropic), on a TypeScript/Node core. The loop is a plain
observe → decide → act cycle: each turn the model gets the accessibility tree of the current screen, a
screenshot of it only to disambiguate identically-named controls, and its previous actions' results,
and replies with typed tool calls. It drives through **our own tool schema** rather than Anthropic's
coordinate-based computer-use tool ([ADR 0002](docs/adr/0002-custom-tool-schema-for-discovery.md)),
because a pixel coordinate cannot become a durable Locator and structured calls leave no transcript to
parse back into steps. The model is confined to discovery — never the replay path — so its
non-determinism is spent once, up front.

The load-bearing decision is how a control is targeted: by its **accessibility role plus accessible
name**, optionally scoped by a parent — never by CSS or XPath
([ADR 0001](docs/adr/0001-accessibility-tree-is-the-targeting-contract.md)). The trade-off is
deliberate. A CSS selector would be quicker to write but is meaningless off the DOM; the accessibility
tree is the one targeting vocabulary shared by browsers (ARIA) and desktop platforms (UIA, AX), so it
is what survives the move to a non-browser Surface the brief asks us to design for. The browser is
merely transport. During discovery the model acts through verbs identical to a Recording's Steps, so
turning a run into a Capability is a filter over what worked, not a translation of a transcript
([ADR 0002](docs/adr/0002-custom-tool-schema-for-discovery.md)). Every path to a screen is gated and
logged by construction — a decorator stack over one Surface interface — so safety and evidence are
structural properties, not conventions a caller has to remember.

## Artifact schema

A Capability is one versioned JSON file — git as the version store, so every change is reviewable as a
diff. It has two parts. The **Contract** is what a calling agent reads: a summary, typed `inputs` and
`outputs` as JSON Schema, declared `effects` (`read-only` or `mutating`), and the **Terminal States**
that can end a run. The **Recordings** are the part it does not read: the ordered Steps.

Four decisions shape it. First, the whole thing is declared once and the static types, the runtime
validation, the discovery tool schema, and the published JSON Schema are all derived from that one
source — so the document a caller reads and the code that runs cannot drift apart. Second, where a
concrete value would sit, a Step stores an **Expression** — a literal or a reference into the inputs —
resolved at replay time; that is what lets one Recording serve any account rather than the one it was
recorded against. Third, each Step carries a stable id, so an override or a failure report names a Step
independent of its position in a list that may change. Fourth, success is a declared predicate over the
screen — a checkpoint, not a boolean — which is what lets an outcome be *recognised* rather than
assumed ([ADR 0004](docs/adr/0004-terminal-states-are-first-class.md)).

The two Capabilities are **deliberately asymmetric**, and the asymmetry is left visible because it is a
real property of the design, not a rough edge. `account-lookup` is read-only: typed inputs and outputs,
a declared Business Outcome, replays unattended. `open-account` is mutating: it takes nothing and
returns nothing, stays a `draft`, and was produced by an *attended* run in which a person completed the
irreversible step. Because its confirmation screen sits on a mutating route a discovery run's gate will
not even read, its success is anchored on the read-only overview instead — a hand-written Capability
could anchor on the confirmation; a discovery-recorded one structurally cannot.

## Determinism & error handling

Replay is deterministic because there is nothing left to decide at run time: same inputs, same Steps,
same outputs, no model to pick a control or judge success. **Ending is declared, not exception-driven**
— the central decision here. A Capability declares exactly one `success` plus named **Business
Outcomes**, each a predicate over the screen. Replay advances until one matches: success returns the
declared outputs; a named outcome such as "no such account" is returned to the caller as a legitimate
answer, never through a `catch`; matching none while unable to proceed is a **Hard Failure** carrying
the Step, what was expected, and what was observed. This is the structural fix for the mistake the
brief names — conflating a business outcome with a crash.

The three runtime classes are declared at three scopes, each where the knowledge actually lives
([ADR 0005](docs/adr/0005-error-taxonomy-split-by-scope.md)): a **Business Outcome** per Capability
(only the lookup knows its own not-found screen), a **Recoverable Condition** per Surface (session
expiry and login interstitials belong to the app, not to any one flow), and **Hard Failure** as the
remainder. All three have committed evidence, not just a description: the Business Outcome (an account
nobody holds, returned as `ACCOUNT_NOT_FOUND`), the Recoverable Condition (a session injected to expire
mid-run, absorbed by re-establishing it and re-running to success), and a Hard Failure (a Recording
pointed at a row the page does not have, stopping with the Step, expected, and observed, plus the
screen it stopped on). Determinism itself is measured rather than asserted: replaying the read-only
lookup twenty times produced **one distinct result — variance 0**. **UI drift** is secondary in this
environment of slow-changing enterprise apps, and is handled by the same machinery: a role-plus-name
Locator absorbs layout change, while a renamed or removed control fails its Step loudly rather than
misfiring silently.

## Heterogeneity & multi-tenant

The **surface seam** is the point of the accessibility-tree decision. The *shape* of a Locator — a
role, an accessible name, an optional parent scope — and the replay engine that resolves it are
surface-agnostic; a legacy web app or a desktop app changes only the transport behind the Surface
interface. What a non-browser surface does touch is the role *vocabulary*: today's roles are ARIA, and
a desktop surface's UIA/AX control types would map onto the same `role` field rather than reshaping the
schema. That mapping is the real work a second surface implies — and the seam between *how we perceive
a surface* and *the recorded flow* is what keeps it to that.

**Across tenants**, many institutions run the same vendor product configured differently. A Capability
holds a base Recording plus per-Tenant **patches keyed by Step id** — override the one Step that
differs, reviewable as a diff, rather than re-recording the flow. On **detecting and managing drift**:
detection needs no separate system because it falls out of the error taxonomy — a tenant whose screen
has diverged fails the affected Step and surfaces a Hard Failure naming exactly the control that
drifted, rather than a silent wrong action. As a complementary early warning, the multi-run stability
check — the same N-replay tool used above, run per-tenant on a schedule — would show a Capability
returning more than one distinct result before it fails outright; that scheduling is design, not
something wired up today. Management is scoped: a localized divergence is a keyed patch; a wholesale
change is a new version (one file per version), so a tenant pins the version it trusts and no one is
rebuilt from scratch. The mechanism is built and tested; a committed second variant is the named cut
below.

## Escalation & handoff

Exactly one **Controller** holds the live session at a time, with explicit transitions. When the policy
gate refuses a Step during an attended run — the system's definition of *stuck* — it raises an
**Intervention Request** carrying the four things an operator needs (the capability, the current Step,
the observed state — the accessibility tree and address, since the operator is already looking at the
rendered screen in the handed-over window — and why it stopped), hands over the *same* live browser
rather than a fresh one,
records what the person does in the same Step list marked as theirs, and takes control back so the run
resumes. The person's manual fix therefore folds into the Recording instead of being re-derived; this
is exactly how `open-account` was produced. Per the brief's scope, the operator interface is the live
browser window plus a loopback resume signal, not a built console. The control-transfer and teardown
were hardened so that however a pause ends, control returns to the agent and nothing is left recording
or listening.

## Safety

Two static guardrails, both owned by us rather than the model. The **policy gate** enforces a
checked-in allowlist — permitted origins, action verbs, and every route split by whether reaching it
can mutate; a route in neither list is refused, so it is an allowlist, not a blocklist with gaps. Risk
is decided from two declared fields — a Capability's `effects` and its `approval` — before a browser
exists, so a mutating Capability nobody has signed off never reaches a screen. The model never rates
its own actions safe: asking the guarded thing to classify itself is the option ADR 0007 rejects
([ADR 0007](docs/adr/0007-risk-is-classified-statically-not-by-the-model.md)). **Redaction** sorts data
into Secret (never written, no flag), Sensitive (masked in evidence, always returned to the caller
intact), and Plain (always written) — a rule about what is stored, never about the result, because
masking the balance would defeat the feature ([ADR 0006](docs/adr/0006-redaction-classifies-data-and-never-touches-the-return-value.md)).

Its **limits**, named rather than hidden: the gate trusts the profile's declaration, so a route
miscategorised read-only that can in fact mutate is a blind spot the gate cannot see — the safeguard is
that the profile is small and reviewed, not inferred. Redaction classifies by field and cannot mask a
value that appears in free-form prose or inside the failure screenshot, which deliberately carries real
balances because a picture cannot be masked without destroying the evidence. There is no defence
against a malicious Recording beyond the same gate and human review of the file. And escalation and the
catalog assume loopback with the operator at the same machine; anything wider needs an auth story this
does not have.

## Cuts

Three of the optional stretch goals were taken, since the core was solid: the agent-facing **capability
catalog**, **draft → approved** gating of unattended mutating replay, and **multi-run stability**. Cut
deliberately, with next steps: no committed second Tenant variant (the mechanism exists; a branded
patch would exercise it); a single real Surface (the seam is ready for a desktop one); `serve` kept
minimal (loopback, no auth, a browser per invoke); the evidence directory fixed rather than
CLI-configurable; and no linter. One honesty note worth keeping: for a while the full test suite passed
green while the live browser-side capture silently recorded nothing — a transpiler artifact only the
built CLI hit — a reminder that a green suite is evidence about the tested path, not the shipped one.
