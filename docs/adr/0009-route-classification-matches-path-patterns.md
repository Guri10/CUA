# Route classification matches path patterns, not literal strings

The policy gate decides whether a URL is allowed and whether it can mutate by matching the path
against the Surface profile's read-only and mutating lists. For ParaBank those are flat literals
(`/transfer.htm`), and `routeOf` matches them by exact string. MERIDIAN's routes are parameterised
by member number (`/members/100234/transfer/review`), so a literal list cannot enumerate them
without listing member ids — and a member id is data, not a route. The match therefore becomes a
path-*pattern* match: a segment like `:id` is a parameter, and a route's read/mutate class is
decided by its verb segments (`/transfer`, `/hold`, `/review`, `/post`), never by which member it
names.

## Considered Options

- **Enumerate the seed member ids in the literal lists.** Brittle, breaks for any member not
  seeded, and mixes data into the route table — the opposite of an allowlist keyed on routes.

## Consequences

This is the one place adapting to MERIDIAN is a change to the core rather than to config: `routeOf`
gains parameter-aware matching (or a path-normalisation step ahead of the existing exact match).
Deny-by-default is unchanged — an unclassified pattern is still refused (ADR 0007) — and ParaBank's
flat routes remain valid patterns with no parameters, so its profile is untouched. Session tokens
attached to a path (`;jsessionid=`) are still stripped before matching, as before; MERIDIAN carries
its session token in a cookie and the sign-on banner instead, so nothing session-scoped reaches the
route table.
