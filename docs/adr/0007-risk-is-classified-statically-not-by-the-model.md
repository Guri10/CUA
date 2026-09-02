# Which actions are risky is a static rule we own; the model has no say

The Surface profile lists which of the application's paths only read (`/overview.htm`,
`/activity.htm`) and which mutate (`/transfer.htm`, `/openaccount.htm`, `/billpay.htm`). A
Capability declares its own effects as read-only or mutating. The model never labels its own
actions as safe or risky. Every action from both the Discovery Run and Replay passes through one
policy gate that checks origin, path, action type, and mutation class before dispatch.

## Considered Options

- **The model flags risky Steps while recording.** Cheapest, and indefensible: it asks the thing
  being guarded against to classify its own behaviour, so a mislabelled money transfer would sail
  straight through a guardrail that reports itself as working.
- **Infer risk from button text** ("Submit", "Transfer", "Confirm"). Fails on the first button
  labelled "Go", and it is a heuristic we would have to defend rather than a rule a reviewer can
  check in ten seconds.

## Consequences

Risk is handled differently by phase, on purpose. During a Discovery Run a risky Step raises an
Intervention Request instead of acting; during Replay a mutating Capability runs only if it has been
marked approved, and otherwise refuses with a clear reason. This makes the guardrails and the
human-escalation path the same mechanism rather than two features side by side — which is how the
brief itself frames it when it says a risky or irreversible step needs a person to decide.

A single gate shared by both phases is deliberate: two enforcement points would eventually disagree,
and the disagreement would be silent.

## Amendment (2026-09-02): observation verbs pass the mutation-class check

The original rule refused *every* action on a mutating route to a run without a write mandate. That
was one word too broad. The thing this gate guards against is a run *changing* data it has no mandate
to change; a `read` or a `waitFor` changes nothing — it observes one value on the screen, exactly as
`snapshot()` does, and `snapshot()` was never gated. Refusing it bought no safety and cost real
capability: the only stable place ParaBank shows a newly-opened account number is the "Account
Opened!" confirmation, served on the mutating `/openaccount.htm` route, so a Discovery Run could not
read it there and fell back to reading it by value off the Accounts Overview — a locator that is
different every run and cannot replay.

So the mutation-class check now gates *state-changing* verbs only. `read` and `waitFor` pass it;
`click`, `fill`, `select`, and `navigate` onto a mutating route are gated exactly as before. Nothing
else moves: classification is still static and profile-owned, the model still has no say, and it is
still one gate for both phases. The escalation path is untouched — the risky Steps that raise an
Intervention Request are the state-changing ones, and they still do. What the amendment adds is that,
once a person has completed the mutation and handed control back on the confirmation screen, the run
can *read* the result it was sent to fetch.

The line held here is "no unmandated **mutation**", not "no presence on a mutating page". One
consequence is worth naming: a Discovery Run can now read the content of a mutating screen it reaches
(e.g. by clicking a link onto one), where before it refused on arrival. That is observation only — it
still cannot act there, and a read's return value is Sensitive-by-position and redacted in evidence
under ADR 0006 — so it widens what the run can *see*, never what it can *do*.
