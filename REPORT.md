# Report

Learn how to drive a legacy app once with a model, then replay it deterministically with no model in
the loop. Built against ParaBank — a real server-rendered Java app with old markup and no test IDs.
Decisions are recorded as ADRs under [`docs/adr/`](docs/adr/); vocabulary in [`CONTEXT.md`](CONTEXT.md).

## Architecture

Two phases, one seam. A **Discovery Run** — the only place a model runs — observes, decides, and acts
on `claude-opus-5` until the goal is met; **Replay** re-runs the result with no model deciding. The
crossing artifact is a **Capability** (Contract + Recordings), exposed by three commands: `discover`,
`replay`, `serve`.

The load-bearing decision is targeting: a control is addressed by **accessibility role plus accessible
name**, never CSS or XPath (ADR 0001) — a selector is quicker but meaningless off the DOM, while the
accessibility tree is the one vocabulary shared by browsers and desktop platforms, so it survives a
move to a non-browser surface. Each turn the model gets the tree, a screenshot only to disambiguate
identically-named controls, and its last results, and replies with typed tool calls whose verbs are
exactly a Recording's Steps (ADR 0002) — our schema, not a coordinate tool, since a pixel is no durable
Locator — so the artifact is a filter over what worked, decoupled from the transcript. Every path to a
screen is gated and logged by construction, enforced by a test.

## Artifact schema

One versioned JSON file, git as the store, diffable. The **Contract** is what a caller reads — typed
`inputs`/`outputs` as JSON Schema, declared `effects`, and the **Terminal States** that end a run; the
**Recordings** are the Steps it doesn't. Four decisions: declared once in Zod, so types, validation, the
tool schema, and the published schema can't drift; a Step stores an **Expression** (a literal or a
reference into the inputs), so one Recording serves any input; each Step has a stable id, named
independent of position; and success is a **declared predicate**, not a boolean — recognised, not
assumed (ADR 0004).

The two Capabilities are **deliberately asymmetric**: read-only `account-lookup` (typed in/out, a
Business Outcome, replays unattended) versus mutating `open-account` (no in/out, stays `draft`, made by
an attended run in which a person did the irreversible step). Its confirmation sits on a mutating route
the discovery gate won't read, so success anchors on the read-only overview — a hand-written Capability
could anchor on the confirmation; a discovery-recorded one cannot.

## Determinism & error handling

Deterministic because nothing is decided at run time. **Ending is declared, not exception-driven**: one
`success` plus named **Business Outcomes**, each a predicate; replay advances until one matches. "No
such account" is a legitimate answer, never a `catch`; matching none while stuck is a **Hard Failure**
carrying Step, expected, and observed — the fix for conflating a business outcome with a crash. The
three classes sit at three scopes (ADR 0005): Business Outcome per Capability, Recoverable Condition per
Surface, Hard Failure the remainder. **All three have committed evidence** — a not-found outcome, a
session injected to expire mid-run then re-established to success, and an injected broken-row failure.
Determinism is measured, not asserted: twenty replays → **variance 0**. UI drift is secondary here and
handled the same way — role+name Locators absorb layout change, while a renamed control fails loudly
rather than silently.

## Heterogeneity & multi-tenant

**Surface seam:** a Locator's shape (role, name, scope) and the replay engine are surface-agnostic; a
legacy or desktop app changes only the transport behind the Surface interface. What a non-browser
surface touches is the role *vocabulary* — ARIA today, UIA/AX mapping onto the same `role` field — the
concrete work a second surface implies.

**Multi-tenant:** a base Recording plus per-Tenant patches keyed by Step id — override one Step, don't
re-record. **Detecting and managing drift:** detection falls out of the taxonomy — a drifted control
fails its Step and names itself, not a silent wrong action; the stability check, run per-tenant on a
schedule, is an early flake signal (design, not wired today). Management is scoped — a local divergence
is a keyed patch, a wholesale change a new version (one file per version), so a tenant pins what it
trusts and nothing is rebuilt. Built and tested; a committed second variant is the cut.

## Escalation & handoff

One **Controller** holds the live session at a time, with explicit transitions. A gate refusal in an
attended run is *stuck*: the system raises an **Intervention Request** (the capability, the current
Step, the observed state as the accessibility tree and address, and why it stopped), hands over the
*same* live browser, records the person's actions into the same Step list marked as theirs, and takes
control back — so the manual fix folds into the Recording. This is how `open-account` was produced. Per
scope, the operator surface is the live window plus a loopback resume signal, not a built console.
Teardown returns control to the agent and leaves nothing recording or listening, however a pause ends.

## Safety

Two static guardrails, owned by us rather than the model. The **policy gate** enforces a checked-in
allowlist of origins, action verbs, and routes split by mutation; anything unlisted is refused. Risk is
decided from `effects` and `approval` before a browser exists, so an unapproved mutating Capability
never reaches a screen, and the model never rates its own actions (ADR 0007). **Redaction** sorts data
into Secret (never written), Sensitive (masked in evidence, always returned to the caller intact), and
Plain (always written) — about what is stored, never the result (ADR 0006).

**Limits:** the gate trusts the profile's declaration, so a miscategorised route is a blind spot;
redaction can't mask a value in prose or inside the deliberately-unmasked failure screenshot; there is
no defence against a malicious Recording beyond review of the file; and escalation and the catalog
assume loopback with the operator at the same machine.

## Cuts

Three optional stretch goals were taken: the agent-facing **catalog** (`serve`), **draft → approved**
gating of unattended mutating replay, and **multi-run stability**. Cut deliberately, with next steps: no
committed second Tenant variant; a single real Surface (the seam is ready for desktop); `serve` kept
minimal (loopback, no auth); the evidence directory fixed rather than CLI-configurable; and no linter.
One honesty note: the suite once passed green while the live capture silently recorded nothing — a green
suite is evidence about the tested path, not the shipped one.
