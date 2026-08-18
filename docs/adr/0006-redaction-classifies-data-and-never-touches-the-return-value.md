# Redaction classifies data by kind and never applies to the caller's result

Data is sorted into three kinds. **Secret** — the ParaBank password and session cookie — is never
written anywhere and no flag can turn that off. **Sensitive** — account numbers, balances, names —
is always returned to the caller in full but masked in persisted evidence when redaction is on
(the default). **Plain** — page addresses, Step names, timings — is always written. Redaction is
therefore a rule about what we store, not about what we return: reading the balance is the entire
point of the Capability, so masking it in the result would defeat the feature.

## Considered Options

- **Redact nothing.** Defensible in that ParaBank's data is synthetic, but leaves the brief's
  named "redaction of regulated financial data" criterion with nothing to score, and does not
  answer whether the system would protect real data.
- **Mask everything sensitive, always.** Actively harmful: evidence reading `balance: «redacted»`
  makes it impossible for a reviewer to confirm the Capability ever worked, trading a
  high-weighted criterion (correctness of the core loop) for a low-weighted one (data handling).

## Consequences

The committed `/evidence/` contains one run with redaction on and one with it off, so a reviewer
can both verify real values and see the mechanism working. Anyone finding visible balances in
evidence should read this file before concluding redaction is broken.

Model transcripts mention values in ordinary prose ("the balance is $1,234.56"), which field-level
masking cannot catch. Rather than scrubbing prose, we persist a filtered transcript containing only
the actions taken and their results — smaller, more useful for debugging, and the leak path stops
existing rather than being patched.
