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
