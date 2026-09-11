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
- **Capability sources** — hand-written typed modules in `src/capability/meridian/*.ts`, compiled by
  `npm run capability:write` into the committed artifacts `capabilities/*/N.json` the runtime reads
  (same seven tasks, source and built form). Hand-written on purpose as the complete reference set
  (every business outcome, the weak-label login, secrets, the supervisor gate, volatile share labels) —
  the whole map a lucky discovery run would only partly walk. Discovery doesn't consume them; deleting
  them loses nothing structural: discovery regrows a *similar* member-lookup, same happy path but
  different names and shape, and the failure outcomes only if the run happened to hit them.
- **Surface adapter** — `src/surface/meridian/`: MERIDIAN's sign-on as a list of Actions, plus a test
  fake so the suite runs without the live site. The one genuinely app-specific piece of glue code.
- **Evidence fixtures** — accessibility trees under `evidence/accessibility-tree/meridian/`. Captured
  from the real browser, not invented, so the test fake serves the actual screens and every
  capability's locators are checked against them — the whole suite runs with no browser or network.

The five load-bearing parts stayed generic: the capability schema, the discovery loop, the replay
engine, the policy gate, and the escalation path.

I did have to grow the core **two general skills**, because MERIDIAN exercises things ParaBank never
did — and I added them as general abilities, not MERIDIAN hacks:

1. **Classifying URLs that carry a record id** (`/members/42/...`). ParaBank's addresses were fixed, so
   the allowlist matched them literally; MERIDIAN puts the member number in the path, which a literal
   list can't cover without one entry per member. The allowlist gained **pattern segments** — a segment
   written `:id` matches any value (`/members/:id/hold`) — so one rule covers every member and the gate
   still decides read-only vs. mutating for the page. *File:* `src/policy/route.ts`.
2. **Reading one value from every row of a list** (e.g. each share on a member's record). ParaBank never
   read a repeating list, so the verb set had no way to say "read this field for every matching row."
   Added a new **`readEach`** verb (ADR 0002's set) — defined once as a step in the capability schema,
   offered to the model as a tool in discovery, and executed in replay — so a capability reads a whole
   table without counting rows or hard-coding how many there are. *Files:* `src/capability/schema.ts`,
   `src/discovery/tools.ts`, `src/replay/`.

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

**Which outcome wins is a fixed order** (`replay.ts`): a gate **refusal** short-circuits mid-run to
`hard-failure` before any screen is read (:286); otherwise the declared **success** predicate is tested
first (:311 — ADR 0004, "steps ran out" is never success); if it misses, `interpret()` asks in order —
**recoverable** condition (:356, which escalates if it recurs past its cap), then **business-outcome**
(:361), then **hard-failure** as the fall-through (:367, "unknown = failure, never success").

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
time there is no un-guarded path to a browser. The design principle throughout is **prevention over
detection**: catastrophic failure modes are driven to low *likelihood by construction* — a
deny-by-default gate decided before a browser opens, a static two-field mandate, a single-controller
session type, recovery that refuses to re-run a mutation — rather than relying on catching them after
the fact.

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

**The one gap inside the guardrails, stated plainly:** the gate decides *whether* a mutating capability
may run, not *which record* it acts on. So if the chatbot maps an under-specified request to a valid
input on the *wrong* share, that is a valid input — invisible to the gate. The fix therefore lives at
the chatbot, the layer that turns language into inputs: an `ask_user` move plus a look-then-ask
instruction and a confirm step on mutating actions. The residual is honest — the *plumbing* is
deterministic and tested (the loop halts on an ask; no money moves), but whether the model *chooses* to
ask is prompt-driven, a model-compliance boundary rather than a guaranteed one.

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

**Deliberate safety residuals** (known, held open with a reason, not oversights):

- **Failure screenshots are unmasked** — you can't field-mask a balance out of an image without
  destroying the evidence, so screenshots are the one place evidence holds a sensitive value (ADR
  0006). Scoped by keeping evidence on loopback and filtering transcripts to actions-only.
- **The allowlist's trust root is the profile being correct** — a mutating route mis-filed as
  read-only is *allowed*, so deny-by-default can't catch it. Defence is a short, static, checked-in
  profile reviewed as a diff; that's the honest limit of a config-driven safety model.
- **The served endpoints are demo-scoped** — loopback-only, no auth on the resume/catalog routes.
  Fine for a demo; a real deployment needs an auth story.

Next, in priority order: (1) make login pluggable; (2) promote discovery output to first-class — teach
the loop to capture terminal states and validation, then approve those recipes; (3) an image-redaction
pass for evidence and an auth story for the served endpoints; (4) wire per-run snapshots into the
dashboard; (5) broaden recoverable/validation coverage; (6) untangle the ParaBank-specific helpers so a
third target is pure config + adapter. Longer term, replace judgment-based risk estimates with real
replay/failure data from a per-capability stability check.
