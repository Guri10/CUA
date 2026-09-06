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
   * The non-secret operator id and branch this installation is configured for.
   *
   * The runs read these from configuration and look the password up by that
   * operator id (#42), so a submission for a different operator or branch would
   * store a password nothing reads and leave "signed on as …" saying one thing
   * while runs act as another. When set, a mismatch is refused rather than
   * stored — the portal supplies the secret for the configured operator, it does
   * not switch which operator the runs act as. Omitted only by tests that drive
   * the store contract directly.
   */
  readonly expected?: { readonly operator: string; readonly branch: string };
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

  return json(outgoing, 404, { why: "The sign-on portal has two routes.", page: "GET /", signOn: "POST /signon" });
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

  // Refuse an operator or branch the runs won't read, before validating one: the
  // password would be stored under an operator nothing looks up, and the page
  // would say "signed on" while every run acted as the configured operator.
  const expected = options.expected;
  if (expected !== undefined && (operator !== expected.operator || branch !== expected.branch)) {
    return json(outgoing, 409, {
      error:
        `This installation signs on as operator "${expected.operator}" at branch "${expected.branch}". ` +
        `Enter those, or change MERIDIAN_OPERATOR / MERIDIAN_BRANCH.`,
    });
  }

  try {
    // Validate first; store only on success, so a bad login leaves the store
    // exactly as it found it — the ticket's "fails fast … stores nothing".
    const signedOn = await options.signOn({ operator, branch, password });
    options.store.set(signedOn.operator, password);
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
