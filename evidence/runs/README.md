# Committed runs

Thirteen runs against a running ParaBank — nine replays and four Discovery Runs — kept so that the
evidence trail and its redaction can be read rather than taken on trust. Every run writes its own
directory here; these thirteen are committed and the rest are yours to delete.

Each holds `run.jsonl` — one JSON record per line, in the order things happened — and, when the run
ended anywhere other than success, `failure.png`: the screen it ended on. The picture is captured at
the Action that missed rather than at the run's ending, so it is named for the miss and not for what
the miss turned out to mean — a run that ended in a Business Outcome has one too, and what it shows
is the screen the outcome was read off.

| Run | What it shows |
| --- | --- |
| `2026-08-19T17-34-18.103Z-…` | A successful lookup with redaction **on**, which is the default. |
| `2026-08-19T17-34-23.512Z-…` | The same lookup with `--evidence-redaction=off`. |
| `2026-08-19T17-34-27.269Z-…` | An account the customer does not hold, before #6: a Hard Failure, with the screen it stopped on. |
| `2026-08-19T22-44-14.631Z-…` | The same request after #6: the declared `ACCOUNT_NOT_FOUND` Business Outcome. |
| `2026-08-22T20-02-02.770Z-…-broken-…` | An **injected failure**: a Recording pointed at a row the account page does not have — standing in for the app changing under a Recording — stops with a Hard Failure naming the Step (`wait-for-balance`, expected vs observed), and `failure.png` is the screen it stopped on. |
| `2026-08-22T20-49-07.451Z-replay-account-lookup` | A **Recoverable Condition**: a session injected to expire on the way to the account detail. Replay matches the profile's `SESSION_EXPIRED`, signs in again (the sign-in appears twice in the log), re-runs the Recording, and finishes `success`. Its `failure.png` is the logged-out screen it recovered from. |
| `2026-08-19T22-21-55.385Z-discover` | A Discovery Run that reached its goal: `claude-opus-5` driving ParaBank. |
| `2026-08-19T22-22-32.856Z-discover` | A Discovery Run told to move money, refused by the policy gate. |
| `2026-08-20T16-58-40.572Z-discover` | A Discovery Run that saved what it worked out as `account-lookup-discovered@1`. |
| `2026-08-21T05-33-36.673Z-discover` | An **attended** Discovery Run for `open-account@1`: the gate refused the irreversible step, a person completed it, and their Steps were folded in `by: human`. |
| `2026-08-20T16-59-10.668Z-…-discovered` | That saved Capability replayed, with no model on the path. |
| `2026-08-20T16-59-13.377Z-…-discovered` | The same replay with `--evidence-redaction=off`, so the values can be read. |
| `2026-08-21T05-36-28.334Z-replay-open-account` | The mutating `open-account@1` replayed (against a temporarily-approved copy) to `success`, with no model in the loop. |

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

**A run that stops stops with its reasons attached.** In the third run, `seq 8` records the
`not-found`, the next record names the screenshot, and `run-finished` carries the Step, what was
expected, what was observed, and the route it was on. That is the shape of every **Hard Failure**:
the run says which Step, what it was aiming at, and what it saw instead.

**The last two replays are the same request either side of #6.** Both ask for an account the customer
does not hold, and both get the same screen from ParaBank: the accounts overview, rows arrived, no
link carrying that number. The earlier one ends `"outcome":"hard-failure"`, because replay matched
only the success Terminal State and an unfound link was all it could say. The later one ends
`"outcome":"business-outcome"` with `ACCOUNT_NOT_FOUND`, because the Capability declares that screen
and replay now recognises it —
[ADR 0005](../../docs/adr/0005-error-taxonomy-split-by-scope.md)'s split, made visible in two logs
of the same question. Nothing about the application changed between them; what changed is what the
system is able to call the answer.

**The injected failure was produced by a deliberately broken Recording, then thrown away.** A copy of
`account-lookup` whose `wait-for-balance` Step was pointed at a row ParaBank's account page does not
have — an "Interest Rate:" row that is not there — was replayed against account 12345 and stopped with
a Hard Failure: `wait-for-balance`, expected "cell $ within row Interest Rate:", observed "no control
matched". It stands in for the one failure Replay exists to catch — the application changing under a
Recording — without waiting for ParaBank to actually change. The broken Capability is not committed
under `capabilities/`; only the run it produced is kept.

**`failure.png` shows real balances, and that is deliberate.** It is a picture, so nothing can mask a
value inside it, and a reviewer needs to see the state the system could not interpret. It is the one
place evidence carries a Sensitive value the flag does not reach.

## The Discovery Runs

**The model found the same controls a person did.** Asked for the type and balance of one account,
it waited for the rows to arrive, clicked the account link, and then read `cell #1 within row
"Account Type:"` and `cell #1 within row "Balance:"` — the same two Locators the hand-written
`account-lookup@1` Capability uses, and the same wait, arrived at independently from the
accessibility tree. That is the targeting contract of
[ADR 0001](../../docs/adr/0001-accessibility-tree-is-the-targeting-contract.md) holding for a model
as well as for a person.

**No reasoning is in the log, and that is the point.** The model gives a sentence with every call
and every one of them was printed to the operator's terminal. None of them is here.
[ADR 0006](../../docs/adr/0006-redaction-classifies-data-and-never-touches-the-return-value.md)
persists a filtered transcript — the Actions taken and their results — because prose mentioning a
balance is exactly what field-level masking cannot catch. The record type has no free-text field to
put one in.

**The account number, before and after #10.** In the two Discovery Runs from the 19th it appears in
full inside a Locator's name: a run's Sensitive-by-value list is its own declared inputs, and a
Discovery Run had none — it was the thing that worked out what the inputs should be. In the run from
the 20th the same Locator reads `"name":"[SENSITIVE]"`, because that run was told which value was the
caller's before it started. What a `read` returned is masked in both, because that is classified by
where it sits rather than by matching a value.

**The refused run stops with no refused Action in it.** The second run was told to transfer money. It
clicked through to the transfer screen, and the first action it tried there was refused. The log
shows the click and then `"outcome":"intervention-request"` carrying the gate's reason — the refused
`fill` is not an Action record, because the gate refuses before dispatch and the evidence decorator
sits inside it. A refusal is the caller's answer and the run's outcome, not something that happened
to the application.

Its `failure.png` is the Transfer Funds form with the amount box still empty, which is the whole
point: the run stopped *before* it typed anything, and a person deciding what to do next can see
exactly the screen it stopped on. That screenshot is taken by the command rather than by the
decorator, because an Action the gate refused never reaches the decorator at all.
[ADR 0007](../../docs/adr/0007-risk-is-classified-statically-not-by-the-model.md) is what makes a
Discovery Run safe to point at an application nobody has taught it: it explores with no mandate to
change anything, and the model has no say in that.

**The last three runs are the loop closed.** The Discovery Run reached the goal and wrote
`capabilities/account-lookup-discovered/1.json`; the two replays beside it ran that file against the
same application with nothing but the recorded Steps deciding anything. Read the discovery log and
the first replay side by side: `seq 7` onwards is the same three Actions in the same order, once
chosen by `claude-opus-5` over eleven seconds of thinking, once dispatched from a file in fifty
milliseconds.

**And the balance is the same one.** That is what the third run is for. Masked evidence cannot show
that a recorded Capability answers what the hand-written one answers, because both sides read
`[SENSITIVE]`. With the flag off, `2026-08-20T16-59-13.377Z` — the recorded Capability — writes
`"value":"SAVINGS"` and `"value":"$1231.10"`, and `2026-08-19T17-34-23.512Z` — the hand-written
`account-lookup@1`, same account, same setting — writes the same two values. A model worked out the
flow, a file recorded it, and the file answers the question the same way.

The recorded Capability declares success and no Business Outcome — a run that reached the balance
never saw the not-found screen — which is why it lands as a draft for a person to finish. It is also
four Steps where the hand-written one is six: the two waits are the checkpoints a person added
knowing that ParaBank fills its tables from a request that finishes after load, and the recorder had
no way to learn that from a run where the table happened to be ready.

## Reading one

```sh
jq -c . 2026-08-19T17-34-27.269Z-replay-account-lookup/run.jsonl
```
