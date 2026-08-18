# The three error classes are declared at three different scopes

Business Outcomes are declared per Capability, Recoverable Conditions per Surface profile, and Hard
Failure is what remains when neither matched. The split follows what each class actually knows
about: only the lookup Capability knows what its own not-found screen looks like, whereas session
expiry and the login interstitial are properties of ParaBank shared by every Capability driving it.

## Consequences

Declaring Recoverable Conditions per Capability would duplicate them across every Capability and
let the copies drift, so that fixing a session-expiry detector in one place would silently leave it
broken elsewhere.

A useful second effect: because Recoverable Conditions live in the Surface profile, onboarding a new
Tenant running the same vendor product means writing a new profile, not re-recording its
Capabilities. This is one half of the multi-tenant answer — the other half being per-variant Step
overrides inside a Recording.
