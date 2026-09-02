# Report

The idea is simple: use a model to figure out how to drive an app once, then replay what it did
without the model in the loop. I built it against ParaBank, Parasoft's self-hosted demo bank. It's a
real server-rendered Java app with old markup and no test IDs, which is the kind of surface that makes
this problem interesting rather than staged.

The decisions below are backed by ADRs in [`docs/adr/`](docs/adr/), and the vocabulary I use is
defined in [`CONTEXT.md`](CONTEXT.md). This write-up is about the reasoning, not the code.

## Architecture

There are two phases with one seam between them. A Discovery Run is the only place a model runs: it
looks at the screen, decides what to do, and acts, over and over, until the goal is met. Replay then
re-runs what the discovery produced, with nothing left for a model to decide. The thing that passes
between the two phases is a **Capability**: a named, versioned unit an agent can call, made of a
Contract and one or more Recordings. Three commands cover this: `discover`, `replay`, and `serve` (a
small catalog an agent can call over HTTP).

Discovery runs on `claude-opus-5`, and the whole thing is TypeScript on Node. The loop itself is
ordinary. Each turn the model gets the accessibility tree of the current screen, a screenshot of that
same screen to tell apart controls that share a name, and the results of whatever it did last, and it
answers with typed tool calls. I gave it our own set of tools rather than Anthropic's built-in
computer-use tool, because that tool works in pixel coordinates, and a coordinate can't be a stable
way to find a control later. Typed calls also mean there's no free-text transcript to parse back into
steps afterward. And since the model only ever runs during discovery, its unpredictability is spent
once, up front, and never in production.

The most important decision is how I point at a control. I use its accessibility role and accessible
name, optionally narrowed by a parent, and never a CSS or XPath selector. A selector would have been
faster to write, but it's meaningless the moment you leave the DOM. The accessibility tree is the one
description of a screen that exists on both browsers and desktop apps, so it's the choice that survives
moving to a surface that isn't a browser, which the brief asks us to plan for. Playwright is just how I
reach the tree today. One more structural point: every way of touching a screen goes through a stack of
wrappers that gate and log it, so "we can't act off the allowlist" and "everything is recorded" are
guaranteed by construction rather than by remembering to do them, and a test enforces that there's no
unwrapped way in.

## Artifact schema

A Capability is a single JSON file, one per version, with git as the version store, so any change shows
up as a normal diff. It has two halves. The **Contract** is the part a calling agent reads: a one-line
summary, typed inputs and outputs written as JSON Schema, whether the Capability only reads or also
mutates, and the terminal states that can end a run. The **Recordings** are the part the caller doesn't
need to see: the ordered list of steps.

A few decisions went into the shape. I declare the whole Capability once, in Zod, and generate
everything else from it (the static types, the runtime validation, the tool schema the model sees, and
the JSON Schema the catalog publishes), so the document a caller reads and the code that runs can't
quietly disagree. Where a real value would go, a step holds an **expression** instead, either a literal
or a reference to one of the inputs, resolved at replay time. That's what lets one Recording work for
any account instead of only the one it was recorded against. Each step has a stable id, so a per-tenant
override or a failure report can point at it even as the list around it changes. And success is a
condition checked against the screen, not a boolean someone sets, so an ending is something the system
recognizes rather than assumes.

The Capabilities I built are deliberately lopsided, and I left that visible instead of smoothing it
over. `account-lookup` is read-only: it takes an account number, hands back a type and a balance, has a
real business outcome for "no such account," and runs unattended. The mutating side has two, and the
pair is a before-and-after I kept rather than hid.

`open-account` came first. It mutates, takes nothing, returns nothing, stays a draft, and came out of
an attended run where a person did the step the gate wouldn't let the agent do. It carried a real
limitation. The new account's number appears in exactly one reliable, labelled place — the "Account
Opened!" confirmation — which lives on the mutating `/openaccount.htm` route, and the policy gate then
refused *every* action on a mutating route to a run with no write mandate, plain `read` included. So
discovery couldn't read the number where it appears and fell back to reading it off the read-only
Accounts Overview by its value (a `read` of the link literally named `15120`). A locator that *is* the
account number is different on every run, so that Recording can't be replayed to return the number:
`open-account` ends by checking the overview and hands back nothing.

`open-acc-v3` is the same task after I fixed that (issue #16, PR #17). The mutation check now skips
observation verbs — `read` and `waitFor` pass on a mutating route, while `click`, `fill`, `select`, and
`navigate` onto one stay gated exactly as before — because a read changes nothing; it is the same thing
`snapshot()` already did ungated, so the blanket refusal bought no safety and cost real capability. The
guardrail is intact: the state-changing steps that open the account still refuse and escalate,
classification is still static and profile-owned, the model still has no say, and it is still one gate
for both phases. ADR 0007 records the amendment and its one honest side effect — a run may now *read* a
mutating page it lands on, never act on it, and read values stay redacted in evidence per ADR 0006.
With the gate opened, `open-acc-v3` reads the number straight off the confirmation, so its output
locator is a position (`link[0]` within `paragraph[3]`) bound to `accountNumber` rather than a baked-in
value. That is what makes a mutating Capability genuinely replayable: the run that recorded it opened
account `15231`, and a later replay opened a *different* real account and returned `15342` — it hands
back whatever *this* run created, which is the whole point.

## Determinism & error handling

Replay is deterministic for a boring reason: there's nothing left to decide while it runs. Same inputs,
same steps, same outputs, and no model choosing a control or judging whether it worked. Endings are
declared up front rather than discovered through exceptions. A Capability names exactly one success
plus any number of named business outcomes, each one a condition over the screen, and replay moves
forward until it matches one. Success returns the declared outputs. A named outcome like "no such
account" comes back as a legitimate answer, not something caught in a catch block. If nothing matches
and the run can't go on, that's a hard failure, and it carries the step it was on, what it expected,
and what it actually saw. That split is the fix for the classic mistake the brief points at: treating a
normal business result as a crash.

I put the three kinds of runtime condition at three different levels, each where the knowledge to
recognize it actually lives. A business outcome belongs to a single Capability, since only the lookup
knows what its own not-found screen looks like. A recoverable condition belongs to the surface, since a
session expiring or a login screen popping up is a fact about ParaBank, not about any one flow. A hard
failure is whatever's left. All three are in the evidence as real runs, not just described: the
not-found outcome, a session I injected to expire mid-run and watched the system re-establish and
finish, and a hard failure from a Recording aimed at a row the page doesn't have. I also measured the
determinism rather than just claiming it: replaying the read-only lookup twenty times gave one and only
one result, so a variance of zero. UI drift matters less here, since these apps change slowly, and the
same machinery covers it anyway. A role-and-name locator shrugs off a layout change, and a control that
gets renamed or removed makes the step fail loudly instead of clicking the wrong thing.

## Heterogeneity & multi-tenant

The seam between surfaces is really the payoff of the accessibility-tree decision. The shape of a
locator (a role, a name, an optional parent) and the engine that resolves it don't care what the
surface is, so moving to a legacy web app or a desktop app only changes the transport underneath the
Surface interface. The one thing a non-browser surface does touch is the vocabulary of roles: today
they're ARIA roles, and a desktop app's UIA or AX control types would map onto the same role field
rather than forcing a new schema. That mapping is the actual work a second surface would take, and the
seam is what keeps it contained to that.

For tenants, the situation is that lots of institutions run the same vendor product with different
config and branding. Rather than re-recording a flow per tenant, a Capability keeps one base Recording
plus small per-tenant patches, each keyed to a step id, so a tenant's correction is just an override of
the one step that differs and reads as a diff. Detecting drift doesn't need anything extra, because it
falls out of the error handling: if a tenant's screen has changed, the affected step fails and the hard
failure names the exact control that moved, instead of silently doing the wrong thing. As a softer
early warning, the same twenty-run stability check could be scheduled per tenant, and a Capability that
had started to flake would show more than one result before it broke outright, though that scheduling
is a design idea and not something I wired up. Managing drift is deliberately cheap: a small divergence
is a keyed patch, and a bigger change is a new version, since every version is its own file, so a
tenant can pin the version it trusts and nobody gets rebuilt from scratch. The mechanism is built and
tested; what I didn't do is commit a second tenant's variant, and that's a cut I list below.

## Escalation & handoff

At any moment exactly one controller holds the live session, either the agent or a person, and the
handoffs between them are explicit. The system's definition of "stuck" is the policy gate refusing a
step during an attended run. When that happens it raises an intervention request with the four things
an operator needs: which Capability, the step it was on, the state it's looking at (the accessibility
tree and the address, since the person is already staring at the rendered page in the window that just
got handed to them), and why it stopped. It hands over the same live browser, not a fresh one, records
everything the person does into the same step list marked as theirs, and then takes control back so the
run can carry on. Because the person's fix lands in the Recording, it doesn't have to be figured out
again next time, and that's exactly how `open-account` got made. The brief lets the operator UI be
minimal, so what a person actually gets is the live browser window plus a one-line curl to resume, not
a built console. I spent some care on the teardown so that no matter how a pause ends, control goes
back to the agent and nothing is left recording or listening.

## Safety

There are two guardrails, both static, and both owned by us rather than by the model. The first is a
policy gate reading a checked-in allowlist: which origins are reachable, which actions are allowed, and
every route sorted by whether reaching it can change anything. Anything not on the list is refused, so
it's an allowlist and not a blocklist with holes. Whether a run is even allowed is decided from two
declared fields, a Capability's effects and its approval, before a browser is open, so a Capability
that mutates and hasn't been approved never reaches a screen. The model is never asked to label its own
actions as safe, because asking the thing you're guarding to police itself is the one option that
clearly doesn't work. The second guardrail is redaction. Data is sorted into three kinds: secrets (the
password and session token, never written anywhere, with no flag to turn that off), sensitive values
(account numbers, balances, names, masked in the saved evidence but always returned to the caller in
full), and everything else (always written). The point is that redaction is about what gets stored,
never about what comes back, because the whole reason for the lookup is to return the balance.

I'd rather name the limits than hide them. The gate only knows what the profile declares, so if a route
is filed as read-only but can actually mutate, that's a blind spot, and the only thing protecting
against it is that the profile is short and gets reviewed. Redaction works field by field, so it can't
catch a sensitive value that shows up in prose or inside the failure screenshot, and that screenshot
deliberately shows real balances, because a picture can't be masked without throwing away the evidence
a reviewer needs. There's no defense against a genuinely malicious Recording beyond the same gate plus
a person reading the file. And the escalation endpoint and the catalog both assume they're on loopback
with the operator at the same machine; anything wider would need an auth story I haven't built.

## Cuts

I took three of the optional stretch goals, since the core held together: the catalog that lets an
agent discover and call a Capability (`serve`), the draft-to-approved gate on unattended mutating
replay, and the multi-run stability check. The things I cut on purpose, with what I'd do next: there's
no committed second-tenant variant, though the mechanism is there and a branded patch would exercise
it; there's only one real surface, with the seam ready for a desktop one; `serve` is deliberately
minimal, loopback-only with no auth and a fresh browser per call; the evidence directory is fixed
rather than something you can point elsewhere; and there's no linter. One honest note I want to keep:
for a while the whole test suite was green while the live capture was silently recording nothing, a
transpiler quirk that only showed up in the built CLI. It's a good reminder that a green suite tells
you about the path you tested, not necessarily the one you ship.
