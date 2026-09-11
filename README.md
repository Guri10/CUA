# Computer-Use Automation System

An LLM works out how to drive a legacy web application **once**; what it learned is then replayed
**deterministically, with no model in the loop.**

The unit that passes between those two phases is a **Capability** — a named, versioned thing an agent
can call, made of a *Contract* (the typed inputs and outputs) and one or more *Recordings* (the steps
to run). Three commands cover the lifecycle:

- **`discover`** — put a model on the live app and let it reach a goal; save what worked as a new
  Capability version.
- **`replay`** — re-run a saved Capability against the app, deterministically, with no model involved.
- **`serve`** — expose the approved Capabilities over HTTP so a calling agent can discover and invoke
  them by name, plus a plain-language **chatbot** and a read-only **dashboard** over the same routine.

The targeting is the accessibility tree (role + name + ordinal), never CSS or XPath, so it survives a
messy legacy UI; every action passes one deny-by-default policy gate; every run writes an evidence
trail. The design reasoning — and the decisions behind that shape — is in [`REPORT.md`](REPORT.md);
the vocabulary is in [`CONTEXT.md`](CONTEXT.md) and the decisions in [`docs/adr/`](docs/adr/).

**This build runs against MERIDIAN CORE** (`https://web-sample.interface-hiring.com`), a hosted legacy
credit-union app — the concrete target for every command and demo below. (The system is
target-neutral: a target is a checked-in Surface profile plus a small adapter, not a rewrite; the
ParaBank path it was first built on still lives beside this one.) The rest of this file is *how to run
it*.

---

## Requirements

- Node 20+ and npm.
- Chromium via Playwright (installed with dependencies).
- Two API keys, each optional depending on what you run:
  - `ANTHROPIC_API_KEY` — only for a **discovery** run (learning a new capability).
  - `CHATBOT_API_KEY` — only for the **chatbot's** intent router.
- Replay, the API, and the dashboard need **no key** — they run the captured recipes.

## Setup

```bash
npm install
npm run build
npm test          # fast suite, no browser and no API key needed (see "Offline / mocked")
```

## Config

- The target URL is checked in — `surfaces/meridian.json`
  (`https://web-sample.interface-hiring.com`) — so no `--base-url` is needed. That file is also the
  **allowlist**: the origins automation may reach, the action verbs permitted, and every route split
  by whether it can change data. A route in neither list is refused.
- **Command-line (unattended) sign-on** reads the environment:
  ```bash
  export MERIDIAN_OPERATOR="teller1"                 # or super1 for supervisor actions
  export MERIDIAN_BRANCH="MAIN-001 - Main Office"    # the exact label the branch dropdown shows
  export MERIDIAN_PASSWORD="<operator password>"      # seeds the in-memory store once
  ```
- **Served (API/chatbot) sign-on** does *not* use those — a person signs on once at the browser
  **portal** (below), and the password lives in memory only, never on a command line or in a file.
- Seed members: `100234, 100987, 101555, 102777, 103001`.

## Offline / mocked

The browser and the LLM are both swappable seams, so the whole thing is testable without either:

- `npm test` runs the full suite against a **FakeSurface** (an in-memory stand-in for the browser)
  and a scripted intent router — **no Chromium, no network, no API key.**
- A build-time test (`no-ungated-surface.test.ts`) proves there is no un-guarded path to a real
  browser, so the mock boundary can't be bypassed.
- The one real-browser end-to-end run is separate: `npm run test:e2e` (needs the hosted target
  reachable).

---

## Run the API, chatbot, and dashboard

```bash
export CHATBOT_API_KEY="sk-ant-..."   # required only for the chatbot
npm run serve
```

Boots one process exposing four things on loopback:

| Piece | URL | What it is |
|---|---|---|
| Capability API | `http://127.0.0.1:8788` | `GET /capabilities`, `POST /capabilities/<id>/invoke` |
| Dashboard (read-only) | `http://127.0.0.1:8789` | watch the catalog + run history |
| Chatbot | `http://127.0.0.1:8790` | ask in plain language (starts only if `CHATBOT_API_KEY` is set) |
| Sign-on portal | `http://127.0.0.1:8791` | sign on once as an operator; unlocks the API + chatbot |

First open the **portal** (`:8791`) and sign on as `teller1` — the API and chatbot stay locked until
you do, and an idle session drops the password automatically.

---

## Demo path (exact commands)

### 1. Record a capability against MERIDIAN (discovery)
The AI learns a flow and saves it as the next version. Read-only flows run hands-off; money-moving
flows use `--attended`, which hands you the live browser at the irreversible step — do it, then
resume.

```bash
export ANTHROPIC_API_KEY="sk-ant-..."

# Read-only — learned end to end on its own (Meridian runs start at /members):
npm run discover -- --surface meridian --entry /members \
  --goal "Open member 100234's record and read every share balance" \
  --capability member-balance --input memberNumber=100234 --output balances

# Money-moving — you authorise the submit, then resume:
npm run discover -- --surface meridian --entry /members --attended \
  --goal "Open the member's record, place a hold on one of their shares with the given reason, and read the confirmation number." \
  --capability place-hold --input memberNumber=100234 --input shareId="100234-S0001-12 - Regular Shares" \
  --input reasonCode="LEGAL - Legal / levy" --input notes="" --output confirmationNumber
# On the refusal it prints a resume URL; after you act:
curl -X POST http://127.0.0.1:8787/resume
```
A saved run lands as a **draft** capability version; a human marks it `approved` to serve it.

### 2. Replay a capability — deterministic, no model
```bash
# Read — structured result out:
npm run replay -- --capability member-balance --input memberNumber=100234

# Money-moving, with DIFFERENT inputs than recorded (read balances first for current share ids):
npm run replay -- --capability funds-transfer \
  --input memberNumber=100234 \
  --input fromShare="100234-S0001-12 - Regular Shares" \
  --input toShare="100234-MMKT-16 - Money Market" \
  --input amount="1.00" --input memo=""
# → { "confirmationNumber": "CN4802xx" }
```

### 3. Invoke via the chatbot
With `npm run serve` running and signed on at the portal, open `http://127.0.0.1:8790` and type:
```
What are the share balances for member 100234?
Transfer $1 from member 100234's regular share to their money market share.
```
It picks the capability, invokes it through the API, and answers in plain language with the
confirmation number / balances. Each run appears on the dashboard (`:8789`).

### 4. Invoke via the raw API
```bash
curl -s http://127.0.0.1:8788/capabilities | jq '.[].id'

curl -s -X POST "http://127.0.0.1:8788/capabilities/member-balance/invoke" \
  -H "content-type: application/json" \
  -d '{"inputs":{"memberNumber":"100234"}}' | jq
```

### 5. See an exceptional state, and an escalation
```bash
# Exceptional state — a teller's Place Hold is refused by MERIDIAN, reported cleanly:
#   signed on as teller1, replay place-hold  → { "outcome": "SUPERVISOR_OVERRIDE_REQUIRED" }
npm run replay -- --capability place-hold \
  --input memberNumber=100234 --input shareId="100234-S0001-12 - Regular Shares" \
  --input reasonCode="LEGAL - Legal / levy" --input notes=""

# Escalation — invoke an unapproved DRAFT version by name; the gate refuses it before any browser:
curl -s -X POST "http://127.0.0.1:8788/capabilities/funds-transfer%403/invoke" \
  -H "content-type: application/json" \
  -d '{"inputs":{"memberNumber":"100234","fromShare":"x","toShare":"y","amount":"1.00","memo":""}}'
# → HTTP 403 { "kind": "escalated", "context": { ... "reason": "...still a draft..." } }
```

> A fuller copy-paste runbook with both CLI and chatbot tracks is in `scratch/friday-demo.md`
> (local only).

---

## Evidence

Every run writes a directory under `evidence/runs/` — each action and its result as one JSON line,
plus a screenshot on any fault. The dashboard reads these. Secrets (the password, the session token)
and raw read values are redacted in the log.

## Ports

catalog `8788` · dashboard `8789` · chatbot `8790` · sign-on portal `8791` · discovery resume `8787`.
