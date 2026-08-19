# Computer-Use Automation System

An LLM works out how to drive a legacy web application once; what it learned is then replayed
deterministically, with no model in the loop.

Read [`CONTEXT.md`](CONTEXT.md) for the vocabulary and [`docs/adr/`](docs/adr/) for the decisions
behind the shape of the system.

## Status

Early. The scaffold, the ParaBank target, the verification of ADR 0001's targeting assumption, the
Capability schema, the replay path, and the policy gate are in place: a hand-written Capability
replays against real ParaBank through an allowlist and returns typed outputs. The `discover` and
`serve` commands are not built yet.

## Requirements

- Node 20 or newer
- Docker, for the target application
- An Anthropic API key, for the discovery path only

## Setup

```sh
npm install
cp .env.example .env
```

Then fill in `.env`. `ANTHROPIC_API_KEY` is only needed for the discovery path. For the target
application, set `PARABANK_USERNAME=john` and `PARABANK_PASSWORD=demo` — the demo user the container
seeds, published by Parasoft and guarding nothing but synthetic data.

Those are the only credentials named anywhere in the repo, and they are named here as a setup
instruction. Nothing defaults them: no value appears in `.env.example` or in any source file, and
the capture script fails rather than guessing.
[ADR 0006](docs/adr/0006-redaction-classifies-data-and-never-touches-the-return-value.md) classes
the application password a Secret, which governs what the running system writes — it never reaches
evidence, logs, or a transcript.

## Start the target application

ParaBank is the proxy Surface ([ADR 0003](docs/adr/0003-parabank-as-the-proxy-surface.md)). One
command:

```sh
docker run -d -p 8080:8080 --name parabank parasoft/parabank
```

It takes a minute or so to come up. It is ready when
<http://localhost:8080/parabank/index.htm> returns a page. Stop it with `npm run parabank:stop`.

The container seeds a demo user, `john` / `demo`. Those are the credentials in `.env.example`; no
real credentials or PII are involved anywhere in this project.

## Commands

| Command | What it does |
| --- | --- |
| `npm test` | Unit and integration tests. Fast, no browser. |
| `npm run test:e2e` | The same interaction against a real browser and a running ParaBank. `HEADED=1` shows the window. |
| `npm run typecheck` | Type check without emitting. |
| `npm run build` | Compile to `dist/`. |
| `npm run replay -- --capability <id>@<v> --input <name>=<value>` | Replay a Capability against the running application. |
| `npm run capture:a11y` | Capture ParaBank's accessibility tree into `evidence/`. Needs ParaBank running. |
| `npm run parabank:start` | Start the target application. |
| `npm run parabank:stop` | Stop and remove it. |

## Replay a Capability

With ParaBank running and `.env` filled in:

```sh
npm run replay -- --capability account-lookup@1 --input accountId=12345
```

It signs in, drives the accounts overview and the account detail screen, checks that the screen it
reached is the one the Capability calls success, and prints the outputs its Contract declares:

```json
{
  "accountType": "CHECKING",
  "balance": "-$2300.00"
}
```

No model runs on this path — not to pick a control, not to decide it worked. A run that cannot
reach its declared success state prints the Step it stopped at, what it expected, and what it saw,
and exits non-zero.

A bare id (`--capability account-lookup`) runs the highest version there is. `--variant <name>`
runs a Tenant's corrected Recording, `--base-url` points at an installation other than
`$PARABANK_BASE_URL`, `--headed` shows the browser window, and `--evidence-redaction=off` writes
the run's evidence unmasked — see below.

## What automation is allowed to touch

Every action — during replay today, during discovery when it lands — passes through one policy gate,
a decorator over the `Surface` interface. Both phases receive an already-wrapped Surface and there is
no unwrapped one to reach for, which is checked by a test rather than left to review
([ADR 0007](docs/adr/0007-risk-is-classified-statically-not-by-the-model.md)).

The rule it enforces is a checked-in file, [`surfaces/parabank.json`](surfaces/parabank.json) — the
**Surface profile**. It names the installation, the origins automation may reach at all, the Action
verbs permitted, and every route split by whether reaching it can change anything. A route in
neither list is refused: this is an allowlist, not a blocklist with gaps.

```sh
$ npm run replay -- --capability account-lookup@1 --input accountId=12345 \
    --base-url http://127.0.0.1:8080/parabank
Could not sign in to http://127.0.0.1:8080/parabank: The origin http://127.0.0.1:8080 is not
allowed by the "parabank" Surface profile.
```

ParaBank is running and reachable at that address. The only thing refusing it is the profile.

A Capability declares its own effects as read-only or mutating, and carries a `draft` or `approved`
state — draft unless the file says otherwise, so nothing the recorder writes unattended is approved
by omission. A mutating Capability that nobody has signed off does not reach a browser at all. The
model never classifies its own actions as safe or risky; the rule is a static list a reviewer can
check in ten seconds.

## What gets written down

Every run opens a directory under [`evidence/runs/`](evidence/runs/) and logs every Action it
dispatched and what that Action returned, one JSON record per line. The log is written by a second
decorator over the same `Surface` interface the policy gate wraps, composed as
`PolicyGated(Evidence(Playwright | Fake))`, so there is no way to reach a screen without being
recorded on the way. When a run stops somewhere it cannot interpret, the screen it stopped on is saved beside the
log as `failure.png`.

What lands in that log is sorted into three kinds
([ADR 0006](docs/adr/0006-redaction-classifies-data-and-never-touches-the-return-value.md)):

- **Secret** — the application password, and the session token ParaBank carries in its URLs. Never
  written, under any setting. There is no flag that reaches these.
- **Sensitive** — account numbers, balances, names. Masked in the log by default, and written in
  full with `--evidence-redaction=off`. Always returned to the caller intact either way: reading the
  balance is the point of the Capability, so masking the result would defeat the feature.
- **Plain** — routes, Step ids, roles, timings. Always written.

```sh
# masked, which is the default
npm run replay -- --capability account-lookup@1 --input accountId=13344

# the same run, unmasked
npm run replay -- --capability account-lookup@1 --input accountId=13344 --evidence-redaction=off
```

One run of each is committed, plus one that fails, so the mechanism can be read rather than taken on
trust. [`evidence/runs/README.md`](evidence/runs/README.md) says which is which.

## Is the accessibility tree good enough to target?

The whole targeting strategy rests on it
([ADR 0001](docs/adr/0001-accessibility-tree-is-the-targeting-contract.md)). It was verified rather
than assumed, before anything was built on top of it:

```sh
npm run capture:a11y
```

The captured trees and the written verdict are in
[`evidence/accessibility-tree/`](evidence/accessibility-tree/). Short version: yes, with the login
form's unnamed inputs needing an ordinal.
