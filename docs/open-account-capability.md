# The open-account Capability, and the risky-action demo

The second Capability — `open-account` — exists to give the risky-action gate and the escalation
path something real to act on, which the read-only `account-lookup` cannot provide. It is kept
deliberately thin, and the ways it is thinner than `account-lookup` are stated here rather than
hidden.

## What it is

`capabilities/open-account/1.json`: open a new savings account on ParaBank, then land back on the
Accounts Overview. It declares `effects: "mutating"` and stays a `draft`.

It was produced by an **attended Discovery Run**, not written by hand — the agent drove as far as
the Open New Account form, the policy gate refused the first action there, and a human operator
completed the account creation. Because a person took Steps in it, the recorder marks the Recording
`mutating` (see `effectsOf` in `src/discovery/record.ts`); nothing the agent did could have mutated
anything, since a Discovery Run holds `discoveryMandate()`.

### How it is thinner than `account-lookup`, on purpose

- **No inputs, no outputs.** `account-lookup` takes an account number and returns a type and a
  balance. `open-account` takes nothing and returns nothing — it is a flow, not a query.
- **Success is anchored on a stable screen, not on the confirmation.** The obvious anchor would be
  the "Congratulations, your account is now open" screen. That screen is served at
  `/openaccount.htm`, which is a **mutating** route, so a Discovery Run's gate refuses to even read
  it (see the escalation below). The Recording therefore ends by returning to the Accounts Overview
  and asserting its heading — a read-only screen the agent is allowed to observe. A hand-written
  Capability could anchor on the confirmation; a discovery-recorded one cannot, and that asymmetry
  is left visible rather than papered over.
- **The new account number is never read.** It only appears on the mutating confirmation screen and
  is different on every run, so reading it would produce a Step that could not replay. The flow
  opens the account and walks away from it.

## The two behaviours demonstrated

### 1. Discovery escalates at the irreversible step

Command:

```
npm run discover -- --goal "Open a new savings account, then return to the Accounts Overview page." \
  --capability open-account --attended
```

The agent navigated to the overview, clicked through to the Open New Account form, and its first
action on that form — selecting the account type — was refused by the gate:

```
"/openaccount.htm" can change data, and this run has no mandate to.
```

The run paused and handed the live browser window to a person, who selected SAVINGS, clicked
**Open New Account**, and returned to the Accounts Overview. Control passed back and the agent
confirmed the final screen. The recorder folded the person's Steps into the Recording as `[human]`.

**Evidence:** `evidence/runs/2026-08-21T05-33-36.673Z-discover/run.jsonl` — one `intervention-request`
(the gate's reason), a `control` transition to `human` and back to `agent`, and 14 actions of which
5 are `by: human`.

### 2. Replay refuses while unapproved, and proceeds once approved

While the Capability is a `draft`, replay refuses before a browser is ever launched (the mandate is
decided from the two declared fields — `effects` and `approval` — per ADR 0007):

```
$ npm run replay -- --capability open-account@1
"open-account@1" can change data and is still a draft, so it will not replay unattended.
Review it and mark it approved.
```

Once a reviewer marks it `approved`, the same command runs the full mutating flow to success — it
opens a real account and lands on the Accounts Overview:

```
$ npm run replay -- --capability open-account@1     # approval: approved
{}
Evidence: evidence/runs/2026-08-21T05-36-28.334Z-replay-open-account
```

**Evidence:** `evidence/runs/2026-08-21T05-36-28.334Z-replay-open-account/run.jsonl` — the recorded
Steps replayed with no model in the loop, finishing `success`.

The committed file stays a `draft`. Approval is a deliberate human act (ADR 0007) and the recorder
never writes it, so the resting state is honest; the successful replay above was run against a
temporarily-approved copy to produce the evidence.

## A capture bug this work surfaced (and fixed)

The escalation only records a person's Steps if the browser-side capture works. It did not, in the
built CLI: the listener source is serialised with `String(installCapture)` and injected into the
page, and esbuild — which `tsx` runs the CLI through — rewrites nested functions to call a `__name`
helper it defines at module scope. Serialised on its own, that reference is dangling, so the script
threw `__name is not defined` before attaching a single listener and the capture silently recorded
nothing. The unit and e2e suites run under Vitest, which does not inject `__name`, so they stayed
green while the real CLI captured empty.

The fix wraps the injected script with a one-identity `__name` shim
(`injectableCaptureScript` in `src/surface/human-actions.ts`); a regression test stands in a body
that names `__name`, exactly as a keep-names transpiler emits, and drives it through the same
wrapper. Without the shim the first live attempt recorded a `read-only`, three-Step Recording that
could not replay; with it, the run above recorded the complete `mutating` flow.
