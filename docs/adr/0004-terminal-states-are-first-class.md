# A Capability declares its Terminal States; success is not a boolean

Rather than a single success Checkpoint plus exception handling, every Capability declares a set of
Terminal States — exactly one `success`, plus named Business Outcomes such as `ACCOUNT_NOT_FOUND` —
each a predicate over the accessibility tree. Replay advances until it matches one: `success`
extracts the declared outputs, a named outcome is returned to the caller as a legitimate answer,
and matching none while unable to proceed is a Hard Failure.

## Consequences

This is the structural fix for what the brief's own glossary calls "the most common design mistake
here" — conflating a business outcome with a crash. Handling "no such account" in a `catch` block
would make it an error at the type level, and every caller would then have to parse error strings
to recover the answer they actually wanted.

The cost is that Business Outcomes must be anticipated and declared. An unanticipated one surfaces
as a Hard Failure with the observed state attached, which is the correct conservative default:
better to stop and report than to guess that an unrecognised screen meant success.
