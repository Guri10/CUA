# Computer-Use Automation System

A system that lets an LLM discover how to operate a legacy back-office application by driving its
UI, then turns what it learned into deterministic automation that runs without a model in the loop.

## Language

### The unit of reuse

**Capability**:
The named, versioned, agent-invocable unit. It declares a contract — typed inputs, typed outputs,
and the terminal states that end a run — and holds one or more Recordings that satisfy it.
_Avoid_: artifact (reserved for the brief's own wording in `REPORT.md`), script, automation, macro

**Recording**:
The ordered list of Steps inside a Capability, produced by a single Discovery Run. A Capability may
hold several — one per Tenant variant of the same underlying app.
_Avoid_: trace, transcript, flow, script

**Step**:
One action within a Recording, addressing one control on the Surface. Carries a stable id so that
variant overrides and failure reports can reference it independently of its position.
_Avoid_: instruction, command, node

**Expression**:
What a Step stores where a concrete value would otherwise sit — either a literal or a reference
into the Capability's inputs. Resolved at Replay time, which is what lets one Recording serve any
account rather than the one it was recorded against.
_Avoid_: parameter, placeholder, template, binding

**Contract**:
A Capability's declared interface — what a caller must supply, what it gets back, and which
terminal states are possible. The part a calling agent reads; the Recording is the part it doesn't.
_Avoid_: signature, API, spec

### Running

**Discovery Run**:
The one-off, LLM-driven run that works out how to accomplish a goal on a Surface by observing,
deciding, and acting. Produces a Recording. The only place a model runs at all.
_Avoid_: training run, exploration, learning phase

**Replay**:
Re-running a Recording against the Surface with no model in the decision loop. Same inputs, same
Steps, same outputs. This is the production path.
_Avoid_: playback, execution, run

**Surface**:
The application interface being driven, together with the means of perceiving and acting on it.
A web page reached over the accessibility tree is one Surface kind; a desktop app reached over
platform accessibility APIs would be another.
_Avoid_: target, app, browser, page

**Controller**:
Who currently holds the right to act on a live session — the agent or a human operator. Exactly one
at a time, with explicit transitions between them.
_Avoid_: owner, driver, mode

### Targeting and verification

**Locator**:
How a Step identifies its control: an accessibility role plus an accessible name, optionally scoped
by a parent Locator. Deliberately not a CSS or XPath expression — the accessibility vocabulary is
the one that survives a move to a non-browser Surface.
_Avoid_: selector, query, path

**Checkpoint**:
A condition asserted against the Surface to confirm the expected state was actually reached, rather
than assuming an action worked.
_Avoid_: assertion, validation, verification

**Terminal State**:
A declared, recognisable end condition for a Capability. Exactly one is Success; the others are
named Business Outcomes. Replay runs until it matches one, or fails.
_Avoid_: end state, final state, exit condition

### Results

**Business Outcome**:
A legitimate answer the caller needs, reached by the application working correctly — "no such
account" is the canonical case. Never a failure, and never an exception.
_Avoid_: error, failure, negative result

**Recoverable Condition**:
A transient or incidental state that Replay is expected to absorb and continue through — a known
interstitial to dismiss, a slow load to wait out, an expired session to re-establish.
_Avoid_: retry, transient error, glitch

**Hard Failure**:
A state Replay cannot interpret or continue from. Stops the run and surfaces which Step, what was
expected, and what was observed.
_Avoid_: crash, exception, bug

**Intervention Request**:
The escalation raised when the system cannot safely proceed, carrying enough context for a human
operator to act — the Capability, the current Step, the observed state, and why it stopped.
_Avoid_: alert, ticket, handoff request

### Deployment

**Tenant**:
One customer institution. Many Tenants run the same underlying vendor product, configured, branded,
and versioned differently.
_Avoid_: customer, client, org, instance
