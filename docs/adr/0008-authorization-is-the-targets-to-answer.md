# Authorization is the target's to answer; the policy gate governs what may run, not who

The system does not model which Operator is allowed to perform which action. Whether a given
Operator may place a hold or post a transfer is the target application's rule to enforce, tenant by
tenant, and MERIDIAN answers it at request time with a `403` "supervisor override required".
Replay treats that refusal as an ordinary Business Outcome — one more case of an attempted action
the target declined — and reports it (`SUPERVISOR_OVERRIDE_REQUIRED`). What the system owns instead
is whether a risky action may run *at all*: a mutating Capability is born a draft and is refused at
Replay until a named human promotes it draft→approved (ADR 0007), which is where accountability for
the risky flow actually transfers.

## Considered Options

- **Read the Operator's role off MERIDIAN's post-login banner** (`(TELLER)` / `(SUPERVISOR)`) and
  pre-empt an unauthorized action at the policy gate before driving it. Attractive — it never
  attempts an action it knows will be denied — but it makes a per-product screen string the basis
  of a safety guarantee, and it does not generalise: another product may show ten roles, unfamiliar
  names, or none. Building authority on it welds a MERIDIAN-ism into the engine and still cannot
  answer for tenants whose rules we never see. If it is ever wanted, it belongs in the Surface
  profile as an optional, advisory fast-fail declared as data (the ADR 0005 seam) — never as the
  guarantee, and always with the target's own refusal as the floor beneath it.
- **Encode each Capability's required role and every tenant's authorization matrix in our own
  config.** The only complete copy of those rules lives in the target; any copy we keep drifts from
  it silently.

## Consequences

The demoable escalation comes from the system's own guardrail, not from a role check: the policy
gate refusing an unapproved (draft) risky action, or the discovery-time Intervention Request, with
a named human in the accountability chain — a stronger safety story than reading a screen label.
The supervisor-gated `403` stays a declared Business Outcome, reported cleanly. The honest one-line
defence when a reviewer asks why there is no role-based pre-emption: authorization is the target's
to decide, so we detect and report it, while the guardrail we own governs what may run at all.
