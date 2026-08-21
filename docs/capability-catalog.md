# The Capability catalog

`npm run serve` exposes the saved Capabilities as a catalog: a small HTTP service, on loopback,
that a calling agent reads to discover what it can invoke and then invokes by name with typed
arguments. This is the stretch goal — the point where the central claim stops being asserted and
starts being demonstrated. The Contract already carries JSON Schema; a second program that reads
the list and successfully invokes one is that schema working rather than that schema described.

An invoke over the catalog is the same replay a command line runs. It drives a real browser, signs
in, runs the Recording with no model in the loop, and leaves the same evidence trail behind. What
the catalog adds is a boundary in front of it: a mutating Capability nobody has approved is refused
before a browser opens, and inputs that do not match the Contract are rejected before any run
starts.

## The two routes

The service listens on `127.0.0.1:8788` by default (`--port` to change it). Loopback only — an
invoke drives a browser and signs into the application, so the catalog assumes the caller is a
program on the same machine, the same assumption the resume endpoint makes.

### `GET /capabilities`

Every Capability, highest version each, with its whole Contract — the summary to choose by, the
input and output JSON Schema to invoke against, the declared effects, and the Terminal States it
can reach. The Recording, the part a caller does not read, is deliberately left out.

```json
[
  {
    "id": "account-lookup",
    "version": 1,
    "contract": {
      "summary": "Look up one account's type and balance by account number.",
      "inputs": {
        "type": "object",
        "properties": { "accountId": { "type": "string", "minLength": 1, "description": "…" } },
        "required": ["accountId"],
        "additionalProperties": false
      },
      "outputs": { "type": "object", "properties": { "accountType": { "type": "string" }, "balance": { "type": "string" } }, "required": ["accountType", "balance"] },
      "effects": "read-only",
      "terminalStates": [ … ]
    }
  }
]
```

### `POST /capabilities/<id>/invoke`

Runs the Capability and returns how it ended. `<id>` is a bare id for the highest version, or
`<id>@<version>` (URL-encode the `@` as `%40`). The body is JSON:

```json
{ "inputs": { "accountId": "12345" }, "variant": "optional-tenant" }
```

Inputs are typed as JSON — a number field takes `12345`, not `"12345"`. The response body is the
same discriminated result a direct replay returns, and the status echoes what `replay`'s exit code
says:

| Outcome | Status | Body |
| --- | --- | --- |
| Success | `200` | `{ "kind": "success", "outputs": { … } }` |
| Business Outcome | `200` | `{ "kind": "business-outcome", "name": "ACCOUNT_NOT_FOUND", "step": "…" }` |
| Hard Failure | `502` | `{ "kind": "hard-failure", "step": "…", "expected": "…", "observed": "…", "url": "…" }` |
| Invalid inputs | `400` | `{ "error": "… do not match the Contract: …" }` |
| Mutating draft | `403` | `{ "error": "… can change data and is still a draft …" }` |
| No such Capability | `404` | `{ "error": "No Capability …" }` |

A Success or a Business Outcome is a `200` the way it is an exit `0` — the application worked, and a
named Business Outcome such as "no such account" is the answer it gave, not a failure. A Hard
Failure is a `502`: the run reached a screen the Capability could not interpret, reported rather
than hidden.

## The worked demonstration

`npm run catalog:demo` is the caller the stretch goal is about — a second program that imports none
of this project's code and speaks only HTTP and JSON. It reads `GET /capabilities`, finds
`account-lookup`, reads the input schema the Contract publishes, invokes it with a typed argument,
and prints what came back. A run that ends in the account's type and balance is the JSON Schema
working end to end.

Because an invoke drives a real browser against a real ParaBank, the demonstration needs the target
application and credentials — the same setup any real run needs. Run it in four steps:

```sh
# 1. Start the target application (Docker).
npm run parabank:start

# 2. Put the demo user's credentials where the run can read them.
cp .env.example .env        # then set PARABANK_USERNAME / PARABANK_PASSWORD

# 3. Start the catalog (leave it running).
npm run serve

# 4. In another terminal, run the caller against it.
npm run catalog:demo
```

`npm run catalog:demo -- --account 13344` looks up a different account, and `--url <catalog>` points
at a catalog somewhere other than the default. When you are done, `npm run parabank:stop` removes
the container.

The catalog's own behaviour — the list, the input rejection, the mutating-draft refusal, and every
result shape — is covered without a browser in `src/catalog/serve.test.ts`, which drives the server
through a fake run. The demonstration above is the one real-browser pass over the whole path.
