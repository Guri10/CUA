/**
 * The catalog client: the chatbot's one and only outbound dependency.
 *
 * Everything the chatbot can do to the outside world it does through these two
 * calls — read the list of Capabilities, invoke one by name. That is the point
 * of the ticket: the chatbot "calls only serve and enforces no guardrails
 * itself". There is no browser here, no credential, no policy check — the
 * catalog answered those before it replied, and this reads the reply.
 *
 * The one thing this file owns is turning HTTP status into the discriminated
 * `InvokeOutcome` the rest of the chatbot switches on, so nothing downstream
 * parses a status code. The catalog's contract (see `serve.ts`): `200` is a
 * success or a Business Outcome, `502` a Hard Failure, `403` an escalation, and
 * a `4xx` a request the caller got wrong. Each maps to exactly one kind; an
 * unrecognised status maps to `rejected` rather than being read as anything
 * softer.
 */
import type { CatalogEntry } from "../catalog/catalog.js";
import type { InvokeOutcome, Invocation } from "./types.js";

export interface CatalogClient {
  /** Every approved Capability with its Contract — the list the router chooses from. */
  list(): Promise<CatalogEntry[]>;
  /** Run one Capability by name and read how it ended. */
  invoke(invocation: Invocation): Promise<InvokeOutcome>;
}

/**
 * A client pointed at a running catalog. `baseUrl` is where `serve` is — the URL
 * it prints on boot, or the loopback one an in-process test server hands back.
 */
export function catalogClient(baseUrl: string): CatalogClient {
  const root = baseUrl.replace(/\/$/, "");

  return {
    async list(): Promise<CatalogEntry[]> {
      const response = await fetch(`${root}/capabilities`);
      const text = await response.text();
      if (response.status !== 200) {
        throw new Error(`The catalog list request failed with status ${response.status}.`);
      }
      const parsed = parseJson(text);
      if (!Array.isArray(parsed)) {
        throw new Error("The catalog list response was not the expected JSON array.");
      }
      return parsed as CatalogEntry[];
    },

    async invoke(invocation: Invocation): Promise<InvokeOutcome> {
      const body: Record<string, unknown> = { inputs: invocation.inputs };
      if (invocation.variant !== undefined) body["variant"] = invocation.variant;

      const response = await fetch(`${root}/capabilities/${encodeURIComponent(invocation.ref)}/invoke`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      // Read as text first: the status is the discriminator, and a body that is
      // not the JSON the catalog is supposed to send (a proxy's HTML error page,
      // a truncated response from a catalog that died mid-reply) must become a
      // plain `rejected` the chatbot can report, never a thrown parse error that
      // crashes the one thing whose job is to report in plain language.
      const text = await response.text();
      const payload = parseJson(text);

      // A success or Business Outcome and a Hard Failure both arrive with their
      // `kind`, so they pass through as the Replay union; an escalation the same.
      // Anything else — an unexpected status, or a body that is not the object it
      // should be — is reported with the status and the catalog's own message
      // rather than dressed up as an outcome the run never reached.
      const known = response.status === 200 || response.status === 502 || response.status === 403;
      if (known && isRecord(payload) && typeof payload["kind"] === "string") {
        return payload as unknown as InvokeOutcome;
      }
      const error = isRecord(payload) && typeof payload["error"] === "string" ? payload["error"] : snippet(text);
      return { kind: "rejected", status: response.status, error };
    },
  };
}

/** JSON if it parses, `undefined` if not — the caller decides what a miss means. */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A short, single-line stand-in when the catalog sent no usable message. */
function snippet(text: string): string {
  const trimmed = text.trim().replace(/\s+/g, " ");
  if (trimmed === "") return "the catalog returned an empty response.";
  return trimmed.length > 200 ? `${trimmed.slice(0, 200)}…` : trimmed;
}
