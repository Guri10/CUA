# ParaBank, self-hosted, is the proxy Surface

We automate Parasoft's ParaBank demo bank, run locally via `docker run -d -p 8080:8080
parasoft/parabank`. It is a genuine server-rendered Java application with the flows the brief names
almost verbatim — look up an account and read its balance, open a new account and reach a
confirmation screen — with old-school markup and no test IDs. Self-hosting removes any terms-of-service
or rate-limit exposure and keeps real credentials and real PII out of the project entirely.

## Considered Options

- **Build our own intentionally-hostile app** (framesets, table layouts, injectable errors). Total
  control, and a second Tenant variant would be trivial. Rejected on credibility: the brief is
  assessing whether we can automate a Surface *we do not control*, and automation that works
  against an app we designed ourselves is much weaker evidence. It would also consume time that
  belongs in the Capability schema and the Replay engine.
- **A public demo site** (saucedemo and similar). Fastest to start, but hands us a clean DOM and so
  sidesteps the "no clean DOM" reality the brief calls its common case.

## Consequences

ParaBank will not produce session expiry, transient slowness, or server errors on demand, so those
Recoverable Conditions are simulated by intercepting requests in the Playwright transport. To keep
the error evidence honest, at least one committed failure run uses a genuinely bad account id and
lets ParaBank itself produce the not-found screen — so the Business Outcome path is proven against
a real application response, not only a synthetic one.
