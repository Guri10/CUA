# Improvement ideas / things to think about more

Scratch notes on `worktree-meridian-adaptation`. Not scoped into tickets yet.

## 1. Sign-on as a first-class capability with a persistent session

Raised 2026-09-06.

**What I want:**
- Keep sign-on as a real invocable **Capability** that can be:
  - invoked **manually** (run it once yourself), or
  - **auto-invoked by the caller agent** (chatbot / API).
- The resulting **session stays valid until sign-off or idle timeout** — later capability
  invocations reuse that session instead of each one re-establishing its own.

**Current state (why this is a change):**
- Sign-on is NOT a capability invoke today. Session establishment is a *Surface* property:
  every replay runs `session.establish()` (`src/surface/session.ts`, driven by
  `logInToMeridian`) as the first steps *inside each run*, before the capability's own steps.
- The `sign-on` capability in the catalog exists only for coverage; the runtime never calls
  it to authenticate.
- Password is seeded from `MERIDIAN_PASSWORD` in `.env` into the in-memory secret store, so
  runs sign themselves in without the portal.
- Confirmed from evidence run `2026-09-06...member-balance`: seq 0–5 = inline sign-on,
  seq 6+ = the inquiry, all in one run.

**Things to think about:**
- Persistent / shared session (one browser context kept alive) vs. per-run fresh session —
  this changes the replay + catalog execution model.
- Role switching: sign-on is env-driven (`MERIDIAN_OPERATOR`/`MERIDIAN_PASSWORD`), so the
  chatbot is locked to `teller1` right now. A real sign-on capability could let the caller
  pick the operator (teller vs `super1`) per session — needed for place-hold's supervisor path.
- Session lifecycle: track "valid until sign-off or timeout." A `SESSION_EXPIRED` recoverable
  condition already exists in `surfaces/meridian.json`.
- ADR 0006 (password is a Secret) must still hold — don't persist the secret.

## 2. Chatbot silently auto-resolves ambiguous *mutating* requests

Raised 2026-09-06.

**What happened:** asked the chatbot "Transfer $1.00 from member 100234's Regular Shares to
their Money Market share, memo 'test transfer'" — without naming a *specific* share (the member
has ~20 Regular Shares and ~13 Money Market shares). The chatbot chained
`member-lookup → member-balance → funds-transfer`, its model **picked concrete OPEN shares on
its own** (fromShare `100234-S0001-14 - Regular Shares ($68.00)`, toShare
`100234-MMKT-16 - Money Market ($26.00)`), appended the live balance to each label (the #50
workaround, done unprompted), and **posted** the transfer (`CN480357`) — all without confirming.

**Is it a bug?** Not in the core: deterministic replay did exactly what it was handed, balances
matched the record (nothing fabricated), and the policy gate correctly allowed it (funds-transfer
is approved + mutating). Verified from evidence run `2026-09-06T16-25-04...funds-transfer`
(`run-started` line leaked the resolved labels).

**The real gap:** for an *irreversible, mutating* action the chatbot chose *which* share to move
money from among 20+ candidates and posted, with no disambiguation or confirmation. Fine for a
read-only lookup; not fine for money movement. The policy gate only decides may-mutate / not — it
doesn't force disambiguation. The chatbot's intent router is where a "stop and ask when a mutating
input is ambiguous" check is missing.

**Things to think about:**
- Make the router ask to disambiguate (or require an explicit share) before a mutating post when
  the request under-specifies a load-bearing input.
- Tie into the existing `confirmMutating`/preview seam in `chatbot.ts` (RunOptions) — maybe force
  confirm whenever an input was model-chosen rather than user-given.
- Distinguish "user named it exactly" from "model guessed it" so only guesses get held.
