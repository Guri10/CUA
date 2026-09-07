# MERIDIAN adaptation — write-up

Adapting the core from ParaBank to a second legacy target (**MERIDIAN CORE**,
`https://web-sample.interface-hiring.com`) was a **configuration + adapter job, not a rewrite**. The
whole ParaBank path is untouched; MERIDIAN was added beside it. The branch is overwhelmingly additive
— new folders next to old ones, not edits inside shared machinery.

*(This is the short version. A longer, plain-English treatment for a non-technical reader lives in
`scratch/core-portability-parabank-to-meridian.md`; the run/demo guide is in `README.md`.)*

## 1. What adapting took, and what in the core I had to change

Added, not changed:

- A **surface profile** — `surfaces/meridian.json`: base URL, allowed origins, permitted action verbs,
  and every route split read-only vs. mutating (an allowlist).
- **Capabilities** for MERIDIAN's tasks under `capabilities/`, same typed format as ParaBank's.
- **Adapter code** — `src/capability/meridian/` (the task executors) and `src/surface/meridian/`
  (sign-on + a fake for tests).
- **Evidence fixtures** — accessibility trees under `evidence/accessibility-tree/meridian/`.

The five load-bearing parts stayed generic: the capability schema, the discovery loop, the replay
engine, the policy gate, and the escalation path.

I did have to grow the core **two general skills**, because MERIDIAN exercises things ParaBank never
did — and I added them as general abilities, not MERIDIAN hacks:

1. **IDs in the URL** (`/members/42/...`) → `src/policy/route.ts` learned id-in-path matching.
2. **List screens** → a new list-read verb threaded through the schema, discovery, and replay.

Two seams remain honestly coupled: **login is a hardcoded switch** (`src/surface/session.ts`) rather
than config, and a few helpers still carry ParaBank's fingerprints. Both work for both apps today;
making login pluggable is the first thing I'd do before a third target.

One quirk cost **zero** core code: MERIDIAN guards every money-moving submit with a hidden
per-transaction token. The system never reads it — the only submit verb is "click the real button,"
so the browser carries whatever fresh token is live. Discovery can't capture it; replay can't staple
a stale one. It falls out of two existing rules (see the page as an accessibility tree; submit only by
real click), so any future token-guarded target inherits it free.

## 2. Exposing capabilities as an API, and the contract shape

`npm run serve` exposes the approved capabilities over HTTP (`src/catalog/`):

- `GET /capabilities` — every approved capability with its **Contract as JSON Schema**.
- `POST /capabilities/<id>[@<version>]/invoke` — body `{ "inputs": {...}, "variant"?: "..." }`.

A capability is named `id@version` (bare id = highest version). Inputs are validated against the
Contract **before any browser opens**; the result is a **discriminated union** —
`success` / `business-outcome` / `hard-failure` / `escalated` — mapped to honest HTTP status
(200 / 200 / 502 / 403). The **Recording (the "how") is deliberately withheld** from the catalog, so a
caller couples to *what* a capability does, never to the UI — which is what makes the target swappable.
Under the hood each invoke runs the **same** `runCapability` routine a CLI replay runs; there is no
second "API path."

A thin **chatbot** (`src/chatbot/`) is the agent-facing form: an LLM router turns an utterance into
capability calls, chains them, and reports in plain language. It enforces **no rules of its own** — it
only calls the catalog and relays what comes back. A read-only **dashboard** (`src/dashboard/`) shows
the catalog and discovery/replay run history.

## 3. Driving the legacy UI reliably, and its exceptional states

Everything is driven through the **accessibility tree** — locators are `role + name + ordinal +
within`; CSS/XPath are banned (ADR 0001) and screenshots are evidence only. This is what survives a
messy legacy UI's markup churn, and it described both apps unchanged. Money-moving recipes walk
*form → review → post* as explicit steps and **wait for the confirmation screen before posting**, then
read the confirmation number back — never a blind-fired irreversible click.

Exceptional states sort into three buckets, recognised by **screen text, never HTTP status**:

- **Business outcome** — a real answer: `NOT_FOUND`, `MULTIPLE_MATCHES`, `INSUFFICIENT_FUNDS`,
  `INVALID_EMAIL` / `INVALID_PHONE`, `SUPERVISOR_OVERRIDE_REQUIRED` (a teller's Place Hold turned back).
- **Recoverable** — a transient blip or a timed-out session, re-established then continued.
- **Hard failure** — anything unmodelled; stop and report.

Two judgement calls: on money-moving actions **recoverable means stop, not silently retry** (re-running
an irreversible post could double it — only read-only flows auto-recover), and **unknown = failure,
never success.** Tested against a fake surface and the live target
(`src/replay/meridian.e2e.test.ts`, `recoverable.meridian.e2e.test.ts`).

## 4. Safety, evidence, and escalation through the new surface

The guardrails hold because **there is one boundary, not three**. The API, chatbot, and dashboard add
no rules; they run the same guarded, logged routine, and `no-ungated-surface.test.ts` proves at build
time there is no un-guarded path to a browser.

- **Allowlist enforced live** — only permitted origins/routes/verbs; a disallowed route is refused and
  the browser never goes there (`policy-gate.e2e.test.ts`).
- **Irreversible actions conservative** — a mutating capability nobody approved is refused at the API
  door, before a browser exists, as a structured `403 escalated` (same `mandateFor` decision replay
  makes). Risk is a static two-field rule (effects + approval), never the model's call (ADR 0007).
- **No secrets / raw PII persisted** — the password lives in memory (portal sign-on, never a flag or
  file); it and the session token are scrubbed from every evidence trail; read values are redacted.
- **Escalation intact** — over HTTP a refusal is a structured `escalated` result; in a live discovery
  run the system hands the real browser to a person and takes it back (`escalation.e2e.test.ts`).

Every run writes an evidence directory (`evidence/runs/`) — each action and result as one JSON line,
plus a fault screenshot — which the dashboard reads.

## 5. What I deliberately left out, and would build next

Cut depth, not capabilities — all seven functions replay live; the API, chatbot, and dashboard are all
real. Kept thin, each at a genuine seam:

- The **discovered recipes are thinner** than the hand-tuned ones (less error-screen handling), kept as
  honest discovery artifacts while the richer versions are served.
- **Login is a hardcoded switch**, not config.
- **Dashboard is minimal** — failure screenshots only, output values shown as counts (redaction), and
  per-run page snapshots kept as separate evidence rather than wired into each row.
- **Chatbot is minimal** — a bounded chain, no memory beyond the current request.
- Some **helpers still carry ParaBank's fingerprints**.

Next, in priority order: (1) make login pluggable; (2) promote discovery output to first-class — teach
the loop to capture terminal states and validation, then approve those recipes; (3) wire per-run
snapshots into the dashboard; (4) broaden recoverable/validation coverage; (5) untangle the
ParaBank-specific helpers so a third target is pure config + adapter.
