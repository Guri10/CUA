/**
 * The sign-on portal over HTTP: the one place an operator hands MERIDIAN the
 * password, on its own loopback port beside the catalog, dashboard, and chatbot
 * (#39 B, #44).
 *
 * A submission is validated once by actually establishing a session — a bad login
 * fails fast and stores nothing, so the store only ever holds a password that
 * signed on. On success the password goes into the in-memory secret store, keyed
 * by the non-secret operator id (#42), and the runs read it from there; the
 * response says who is signed on and never carries the password back.
 *
 * The validator is injected rather than built here, exactly as the chatbot is
 * injected into its server: this file's request handling is tested over real HTTP
 * with a fake validator, and the real one (`browser-sign-on.ts`) drives a browser.
 *
 * Loopback only, and the same two guards the chatbot's mutating route carries: a
 * required JSON content-type keeps a cross-origin form from posting here without a
 * preflight, and a required loopback Host defeats DNS-rebinding. Storing a
 * password is the spec's "assumes the human is at the same machine", made a
 * property of the socket by binding to 127.0.0.1.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { redactSessionIds } from "../evidence/redact-session-ids.js";
import type { SecretStore } from "../surface/secret-store.js";
import type { LoginSession } from "../surface/login-session.js";
import { signOnPage } from "./page.js";

/**
 * Fixed rather than random, so a README can print a URL that works. The resume
 * endpoint reserves 8787, the catalog 8788, the dashboard 8789, the chatbot
 * 8790; this is the portal's, adjacent so the set reads as one installation's.
 */
export const DEFAULT_SIGNON_PORT = 8791;

/** A cap on the request body, so one endless request cannot grow the heap. */
const MAX_BODY_BYTES = 100_000;

/** What the operator submits: the operator id and branch (non-secret) and the password (Secret). */
export interface SignOnRequest {
  readonly operator: string;
  readonly branch: string;
  readonly password: string;
}

/** What a successful validation reports: who is signed on, and their role if the banner gave one. */
export interface SignedOn {
  readonly operator: string;
  readonly role?: string;
}

/**
 * Validates a submission by establishing a session once, returning who signed on
 * or throwing with a clear message on a bad login. Injected so the server is
 * tested without a browser; `browserSignOn` is the real one.
 */
export type SignOn = (request: SignOnRequest) => Promise<SignedOn>;

export interface SignOnPortalOptions {
  /** The validator to run on each submission. */
  readonly signOn: SignOn;
  /** Where a validated password is put, keyed by operator id (#42). */
  readonly store: SecretStore;
  /**
   * The served login session this portal drives (#51). A validated sign-on marks
   * it live and records who signed on, so the catalog and chatbot unlock and act
   * as that operator; `POST /signoff` ends it. The session also owns the
   * one-operator-per-boot rule: a sign-on for a *different* operator than the one
   * already locked is refused before the browser is ever driven. Omitted by tests
   * that drive the store/validator contract on their own.
   */
  readonly session?: LoginSession;
  /** Zero asks the operating system for a free one, which is what tests use. */
  readonly port?: number;
}

export interface SignOnPortal {
  /** Where a person points a browser. */
  readonly url: string;
  /** Stops listening. */
  close(): Promise<void>;
}

export async function startSignOnPortal(options: SignOnPortalOptions): Promise<SignOnPortal> {
  const page = signOnPage();

  const server = createServer((incoming, outgoing) => {
    handle(incoming, outgoing, options, page).catch((thrown) => {
      // A handler that threw is a server fault, scrubbed of any session id the
      // way evidence is. This path cannot strip the password, so it relies on an
      // invariant: nothing that has the password in hand throws to here — the
      // validator call is wrapped in a try/catch that turns errors into a 401 via
      // `withoutSecret`, and every guard before it runs before the password is
      // read. Keep it that way; a future edit that reads the password earlier must
      // not let it reach this catch.
      const message = thrown instanceof Error ? thrown.message : String(thrown);
      json(outgoing, 500, { error: redactSessionIds(message) });
    });
  });

  const port = options.port ?? DEFAULT_SIGNON_PORT;
  await new Promise<void>((resolve, reject) => {
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
  options: SignOnPortalOptions,
  page: string,
): Promise<void> {
  const path = new URL(incoming.url ?? "/", "http://127.0.0.1").pathname;

  if (incoming.method === "GET" && path === "/") {
    outgoing.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return void outgoing.end(page);
  }

  if (incoming.method === "POST" && path === "/signon") {
    return await signOn(incoming, outgoing, options);
  }

  if (incoming.method === "POST" && path === "/signoff") {
    return signOff(incoming, outgoing, options);
  }

  return json(outgoing, 404, {
    why: "The sign-on portal has three routes.",
    page: "GET /",
    signOn: "POST /signon",
    signOff: "POST /signoff",
  });
}

/**
 * End the served session now (#51): clear it and drop the password, so the
 * catalog and chatbot lock again until a fresh sign-on. It changes server state,
 * so it carries both guards the sign-on route does: a required JSON content-type,
 * which forces a preflight a cross-origin page cannot satisfy (the CSRF defense —
 * without it a plain cross-origin POST could sign the operator off), and a
 * loopback Host, which defeats DNS-rebinding.
 */
function signOff(incoming: IncomingMessage, outgoing: ServerResponse, options: SignOnPortalOptions): void {
  const contentType = incoming.headers["content-type"] ?? "";
  if (!contentType.includes("application/json")) {
    return json(outgoing, 415, { error: "POST /signoff expects a JSON content-type (Content-Type: application/json)." });
  }
  if (!hostIsLoopback(incoming)) {
    return json(outgoing, 403, { error: "The sign-on portal only answers requests addressed to it on loopback." });
  }
  options.session?.signOff();
  return json(outgoing, 200, { signedOff: true });
}

async function signOn(incoming: IncomingMessage, outgoing: ServerResponse, options: SignOnPortalOptions): Promise<void> {
  // The same guards the chatbot's mutating route carries: this route holds a
  // password and, on success, changes server state, so both apply even on loopback.
  const contentType = incoming.headers["content-type"] ?? "";
  if (!contentType.includes("application/json")) {
    return json(outgoing, 415, { error: "POST /signon expects a JSON body (Content-Type: application/json)." });
  }
  if (!hostIsLoopback(incoming)) {
    return json(outgoing, 403, { error: "The sign-on portal only answers requests addressed to it on loopback." });
  }

  const body = await readJson(incoming);
  if (body.kind === "invalid") return json(outgoing, 400, { error: body.reason });

  const operator = nonBlank(body.value["operator"]);
  const branch = nonBlank(body.value["branch"]);
  const password = nonBlank(body.value["password"]);
  if (operator === undefined || branch === undefined || password === undefined) {
    return json(outgoing, 400, { error: "Sign-on needs a non-blank operator, branch, and password." });
  }

  // One operator per boot (#51): a sign-on for a different operator than the one
  // this process already locked onto is refused before the browser is driven —
  // the runs act as the locked operator, and switching needs a restart.
  if (options.session !== undefined && !options.session.accepts(operator)) {
    return json(outgoing, 409, {
      error:
        `This installation is signed on as operator "${options.session.lockedOperator()}" until it restarts. ` +
        `Sign on as "${options.session.lockedOperator()}", or restart to change operator.`,
    });
  }

  try {
    // Validate first; store only on success, so a bad login leaves the store
    // exactly as it found it — the ticket's "fails fast … stores nothing".
    const signedOn = await options.signOn({ operator, branch, password });
    // Take the one-per-boot lock and go live *before* storing (#51). The
    // pre-validation `accepts` check can pass for two different operators
    // submitted at once, since nothing is locked while both browsers validate;
    // this is the authoritative point. Refusing here — before `store.set` — means
    // a losing race stores no orphaned password. Synchronous with the store write
    // below, so no invoke can observe "live but no password".
    if (options.session !== undefined && !options.session.accepts(signedOn.operator)) {
      return json(outgoing, 409, {
        error:
          `This installation is signed on as operator "${options.session.lockedOperator()}" until it restarts. ` +
          `Sign on as "${options.session.lockedOperator()}", or restart to change operator.`,
      });
    }
    options.store.set(signedOn.operator, password);
    // Mark the served session live as this operator and branch, so the catalog
    // and chatbot unlock and every following invoke signs on as them (#51).
    options.session?.signOn({ operator: signedOn.operator, branch });
    return json(outgoing, 200, {
      operator: signedOn.operator,
      ...(signedOn.role !== undefined ? { role: signedOn.role } : {}),
      signedOnAs:
        signedOn.role !== undefined
          ? `${signedOn.operator} (${signedOn.role})`
          : signedOn.operator,
    });
  } catch (thrown) {
    // A bad login is the operator's answer, not a server fault: 401 with a clear
    // message. The submitted password is stripped from whatever the validator
    // said, so a careless validator cannot leak it back through the response.
    const message = thrown instanceof Error ? thrown.message : String(thrown);
    return json(outgoing, 401, { error: withoutSecret(message, password) });
  }
}

/** A trimmed non-blank string, or undefined for anything else. */
function nonBlank(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

/** Remove the submitted password from a message before it leaves the server. */
function withoutSecret(message: string, password: string): string {
  return message.split(password).join("«password»");
}

/** Whether the request's Host header names a loopback address — the rebinding guard. */
function hostIsLoopback(incoming: IncomingMessage): boolean {
  const host = incoming.headers["host"];
  if (host === undefined) return false;
  const name = host.replace(/:\d+$/, "");
  return name === "127.0.0.1" || name === "localhost" || name === "[::1]" || name === "::1";
}

type Body =
  | { readonly kind: "ok"; readonly value: Record<string, unknown> }
  | { readonly kind: "invalid"; readonly reason: string };

/** The request body as a JSON object. */
async function readJson(incoming: IncomingMessage): Promise<Body> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of incoming) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) {
      incoming.destroy();
      return { kind: "invalid", reason: "The request body is larger than the portal will read." };
    }
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (text === "") return { kind: "invalid", reason: "The request body is empty." };

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

function json(outgoing: ServerResponse, status: number, body: unknown): void {
  outgoing.writeHead(status, { "content-type": "application/json" });
  outgoing.end(`${JSON.stringify(body, null, 2)}\n`);
}

/** Port zero means the operating system chose; ask it which. */
function listeningPort(server: Server, asked: number): number {
  const address = server.address();
  return typeof address === "object" && address !== null ? address.port : asked;
}
