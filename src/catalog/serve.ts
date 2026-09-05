/**
 * The catalog over HTTP: the stretch goal that turns the central claim from
 * asserted to demonstrated. A second program reads the list, reads one
 * Capability's Contract as JSON Schema, and invokes it by name with typed
 * arguments — which is the schema working rather than the schema described.
 *
 * Two routes and nothing else:
 *
 *   GET  /capabilities              every Capability with its Contract
 *   POST /capabilities/:ref/invoke  run one by name and return its result
 *
 * `:ref` is a Capability reference the way a command line names one — a bare id
 * for the highest version, or `<id>@<version>` (URL-encode the `@`). The invoke
 * body is `{ "inputs": { ... }, "variant"?: "..." }`, inputs already typed as
 * JSON.
 *
 * The two guarantees the Contract is a boundary for both live here rather than
 * in the injected runner: a mutating draft is refused before a browser exists
 * (the same `mandateFor` decision `replay` makes), and invalid inputs are
 * rejected against the Contract before any run starts. What is left for the
 * runner is only the run, and its result comes back in the same discriminated
 * shape a direct replay returns — success and Business Outcome as answers, a
 * Hard Failure as the screen the run could not interpret.
 *
 * The refusal is not a bare error: it surfaces as an `escalated` terminal status
 * carrying context — which Capability, where it stopped, and why — the
 * Intervention Request an operator would read, minus the observed screen a
 * refusal before a run never has. That is the deliberate difference from the
 * CLI's live handover: over HTTP there is no browser to give a person, so the
 * escalation is the status and its context, returned to the caller.
 *
 * How the run happens is injected. In production it drives a real browser; in a
 * test it drives a Fake Surface. The server does not know which, which is what
 * lets its two guarantees be tested without a browser.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { loadCapabilityRef, parseCapabilityRef } from "../capability/storage.js";
import type { Capability } from "../capability/schema.js";
import { parseContractValues } from "../replay/contract-values.js";
import { redactSessionIds } from "../evidence/redact-session-ids.js";
import { mandateFor } from "../policy/mandate.js";
import type { ReplayResult } from "../replay/replay.js";
import type { EscalationContext } from "../escalation/intervention-request.js";
import { listCatalog } from "./catalog.js";

/**
 * How an invoke ended, as the catalog returns it: the Replay union plus the one
 * terminal status the catalog can reach that a Replay cannot — an escalation.
 *
 * The spec asked whether the existing union already carries `escalated`. It does
 * not, and should not: a gate refusal *during* a Replay is a Hard Failure — the
 * run reached a screen it could not act on — while escalation as a terminal
 * status is the *pre-run* gate refusing a mutating draft, which happens in this
 * file, before any run. So the union widens here, at the boundary that owns the
 * gate, rather than in `replay`.
 */
export interface Escalated {
  readonly kind: "escalated";
  /** Which Capability, where it stopped, and why. See `EscalationContext`. */
  readonly context: EscalationContext;
}

/**
 * Where a pre-run refusal "stopped". Not a Recording Step — the run never
 * started — but the policy gate itself. The Intervention Request wants a place
 * the operator can name, and for a refusal before a run this is the honest one.
 */
const POLICY_GATE_STEP = "the policy gate, before the run started";

/**
 * A cap on the invoke body, so one caller streaming an endless request cannot
 * grow the process heap until it falls over. An invoke body is a small object
 * of typed inputs; a megabyte is orders of magnitude more than that and still
 * nothing to a machine.
 */
const MAX_BODY_BYTES = 1_000_000;

/**
 * Fixed rather than picked from whatever is free, so a README can print a URL
 * that works and a port already in use fails loudly instead of moving somewhere
 * the caller was not told about. `replay` and the resume endpoint reserve their
 * own; this is the catalog's.
 */
export const DEFAULT_CATALOG_PORT = 8788;

/**
 * How a Capability is run once the server has loaded it, checked its mandate,
 * and validated the inputs against its Contract. The result is a `ReplayResult`
 * so that what the catalog returns and what a direct replay returns are the
 * same union by construction.
 */
export type InvokeCapability = (
  capability: Capability,
  inputs: Readonly<Record<string, unknown>>,
  options: { readonly variant?: string },
) => Promise<ReplayResult>;

export interface CatalogServerOptions {
  /** Where the Capabilities are. */
  readonly root: string;
  /** How to run one. Injected so the run can be a real browser or a fake. */
  readonly invoke: InvokeCapability;
  /** Zero asks the operating system for a free one, which is what tests use. */
  readonly port?: number;
}

export interface CatalogServer {
  /** Where a caller points its requests. */
  readonly url: string;
  /** Stops listening. */
  close(): Promise<void>;
}

export async function startCatalog(options: CatalogServerOptions): Promise<CatalogServer> {
  const server = createServer((incoming, outgoing) => {
    handle(incoming, outgoing, options).catch((thrown) => {
      // A route handler that threw is a server fault, not a run outcome — the
      // request never reached a Terminal State to report one. Answered rather
      // than left to crash the process, so one bad request does not take the
      // catalog down. A thrown run carries a browser or navigation error, and a
      // ParaBank URL carries a session token ADR 0006 classes a Secret, so the
      // message is scrubbed the way evidence is before it goes back over the wire.
      const message = thrown instanceof Error ? thrown.message : String(thrown);
      reply(outgoing, 500, { error: redactSessionIds(message) });
    });
  });

  const port = options.port ?? DEFAULT_CATALOG_PORT;
  await new Promise<void>((resolve, reject) => {
    // Removed once listening, so a later server-level error is not delivered to
    // an already-settled promise and quietly lost — startup failures reject,
    // post-startup ones surface as an uncaught error rather than vanishing.
    const onStartupError = (error: Error): void => reject(error);
    server.once("error", onStartupError);
    server.listen(port, "127.0.0.1", () => {
      server.removeListener("error", onStartupError);
      resolve();
    });
  });

  return {
    url: `http://127.0.0.1:${listeningPort(server, port)}`,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function handle(
  incoming: IncomingMessage,
  outgoing: ServerResponse,
  options: CatalogServerOptions,
): Promise<void> {
  const path = new URL(incoming.url ?? "/", "http://127.0.0.1").pathname;

  if (incoming.method === "GET" && path === "/capabilities") {
    return reply(outgoing, 200, await listCatalog(options.root));
  }

  const ref = invokeRef(path);
  if (incoming.method === "POST" && ref !== undefined) {
    return await invoke(incoming, outgoing, options, ref);
  }

  return reply(outgoing, 404, {
    why: "The catalog has two routes.",
    list: "GET /capabilities",
    invoke: "POST /capabilities/<id>[@<version>]/invoke",
  });
}

/** `/capabilities/<ref>/invoke` → the decoded `<ref>`, or undefined if not that shape. */
function invokeRef(path: string): string | undefined {
  const match = /^\/capabilities\/([^/]+)\/invoke$/.exec(path);
  return match === null ? undefined : decodeURIComponent(match[1]!);
}

async function invoke(
  incoming: IncomingMessage,
  outgoing: ServerResponse,
  options: CatalogServerOptions,
  ref: string,
): Promise<void> {
  // A reference that is not a reference is a bad request, not a missing one:
  // `account-lookup@latest` is the caller asking wrong, and telling that apart
  // from "no such Capability" is the point of the discriminated HTTP surface.
  try {
    parseCapabilityRef(ref);
  } catch (thrown) {
    return reply(outgoing, 400, { error: thrown instanceof Error ? thrown.message : String(thrown) });
  }

  let capability: Capability;
  try {
    capability = await loadCapabilityRef(options.root, ref);
  } catch (thrown) {
    return reply(outgoing, 404, { error: thrown instanceof Error ? thrown.message : String(thrown) });
  }
  const named = `${capability.id}@${capability.version}`;

  // Decided before the runner is even called, from two declared fields (ADR
  // 0007): a mutating Capability nobody has signed off does not get as far as a
  // screen. The same decision `replay` makes, in the same place — before a
  // browser exists. The refusal surfaces as an escalated terminal status with
  // context rather than a bare error, so a caller reads a stopped-with-context
  // result the same shape it reads every other ending. Still a 403: the run was
  // forbidden, and the body says why in a form the caller can act on.
  const mandate = mandateFor(capability);
  if (!mandate.allowed) {
    const escalated: Escalated = {
      kind: "escalated",
      context: { capability: named, step: POLICY_GATE_STEP, reason: mandate.reason },
    };
    return reply(outgoing, 403, escalated);
  }

  const body = await readJson(incoming);
  if (body.kind === "invalid") return reply(outgoing, 400, { error: body.reason });

  let inputs: Record<string, unknown>;
  let variant: string | undefined;
  try {
    variant = readVariant(body.value["variant"]);
    // Against the Contract, before any run starts. A caller that sent the wrong
    // shape is told which field and which side failed, and nothing touches a
    // screen — the same reason `replay` checks its inputs before launching a
    // browser.
    inputs = parseContractValues(capability.contract.inputs, asInputs(body.value["inputs"]), `Invocation of ${named}`);
  } catch (thrown) {
    return reply(outgoing, 400, { error: thrown instanceof Error ? thrown.message : String(thrown) });
  }

  const result = await options.invoke(capability, inputs, variant === undefined ? {} : { variant });
  // The discriminated union, unchanged, with the status echoing what `replay`'s
  // exit code says: an answer or a named Business Outcome is a 200 the way it is
  // an exit 0, and a Hard Failure is a 502 the way it is an exit 1 — the run
  // reached a screen it could not interpret, reported rather than hidden.
  return reply(outgoing, result.kind === "hard-failure" ? 502 : 200, result);
}

/** The invoke body inputs, defaulted to none and required to be an object. */
function asInputs(value: unknown): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invocation inputs must be a JSON object.");
  }
  return value as Record<string, unknown>;
}

/** The optional variant, which names a Tenant's Recording; a string or nothing. */
function readVariant(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new Error("Invocation variant must be a string.");
  return value;
}

type Body =
  | { readonly kind: "ok"; readonly value: Record<string, unknown> }
  | { readonly kind: "invalid"; readonly reason: string };

/** The request body as a JSON object. An empty body is no inputs, not an error. */
async function readJson(incoming: IncomingMessage): Promise<Body> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of incoming) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) {
      incoming.destroy();
      return { kind: "invalid", reason: "The request body is larger than the catalog will read." };
    }
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (text === "") return { kind: "ok", value: {} };

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { kind: "invalid", reason: "The request body is not valid JSON." };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { kind: "invalid", reason: "The request body must be a JSON object." };
  }
  return { kind: "ok", value: parsed as Record<string, unknown> };
}

function reply(outgoing: ServerResponse, status: number, body: unknown): void {
  outgoing.writeHead(status, { "content-type": "application/json" });
  outgoing.end(`${JSON.stringify(body, null, 2)}\n`);
}

/** Port zero means the operating system chose; ask it which. */
function listeningPort(server: Server, asked: number): number {
  const address = server.address();
  return typeof address === "object" && address !== null ? address.port : asked;
}
