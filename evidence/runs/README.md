# Committed runs

Three replays of `account-lookup@1` against a running ParaBank, kept so that the evidence trail and
its redaction can be read rather than taken on trust. Every run writes its own directory here; these
three are committed and the rest are yours to delete.

Each holds `run.jsonl` — one JSON record per line, in the order things happened — and, when the run
stopped somewhere it could not interpret, `failure.png`.

| Run | What it shows |
| --- | --- |
| `2026-08-19T17-34-18.103Z-…` | A successful lookup with redaction **on**, which is the default. |
| `2026-08-19T17-34-23.512Z-…` | The same lookup with `--evidence-redaction=off`. |
| `2026-08-19T17-34-27.269Z-…` | A lookup that stops rather than succeeding, with the screen it stopped on. Redaction on. |

## What to look at

**The password is not in any of them.** In the unmasked run, `seq 1` fills the username box with
`john` in plain text and `seq 2` fills the password box with `[REDACTED]`. That is the difference
between ADR 0006's two protected kinds: the flag moved the username, and there is no flag that
reaches the password. The session token ParaBank writes into its URLs is gone from all three for the
same reason.

**Sensitive values move with the flag and only there.** The masked runs write
`"value":"[SENSITIVE]"` where the unmasked one writes `"value":"$1231.10"`. Both runs printed
`$1231.10` to the caller. Redaction is a rule about what is stored, never about what is returned —
masking the balance in the result would defeat the Capability.

**The failed run stops with its reasons attached.** `seq 8` records the `not-found`, the next record
names the screenshot, and `run-finished` carries the Step, what was expected, what was observed, and
the route it was on.

That run asks for an account the customer does not hold, and today it ends as a **Hard Failure**:
replay matches only the success Terminal State so far. The Capability already declares
`ACCOUNT_NOT_FOUND`, and #6 is where this same real ParaBank response is matched as that Business
Outcome instead. Read the run as evidence that a run which did not succeed says so loudly — not yet
as evidence of the Business Outcome path.

**`failure.png` shows real balances, and that is deliberate.** It is a picture, so nothing can mask a
value inside it, and a reviewer needs to see the state the system could not interpret. It is the one
place evidence carries a Sensitive value the flag does not reach.

## Reading one

```sh
jq -c . 2026-08-19T17-34-27.269Z-replay-account-lookup/run.jsonl
```
