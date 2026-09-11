/**
 * The chatbot over HTTP: the human-facing half of the same `serve` process, on
 * its own port beside the catalog and the dashboard. A person opens the page and
 * asks in plain language; the browser posts the request here, this server runs
 * the chatbot, and the structured chain comes back for the page to render.
 *
 * It is not a second boundary. The chatbot it drives calls the catalog over HTTP
 * exactly as the CLI does (ADR 0007: the catalog is the only place effects and
 * approval are decided), so the strongest thing a request here can do is ask the
 * catalog to run an approved Capability — which the catalog would run for any
 * caller. The one credential is the operator's `CHATBOT_API_KEY`, held by the
 * chatbot this server was handed and never sent to the browser.
 *
 * Two routes:
 *
 *   GET  /       the chat page
 *   POST /chat   run one request; body { message, preview?, confirm?, proceed? }
 *
 * The chatbot is injected rather than built here, so this file's request handling
 * is tested without a model or a browser — a fake chatbot answers, and the two
 * routes are exercised over real HTTP.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { redactSessionIds } from "../evidence/redact-session-ids.js";
import type { Chatbot } from "./chatbot.js";
import type { Invocation } from "./types.js";
import { chatPage } from "./page.js";

/**
 * Fixed rather than random, so a README can print a URL that works. The catalog
 * reserves 8788, the dashboard 8789, the resume endpoint 8787; this is the
 * chatbot's, adjacent so the set reads as one installation's ports.
 */
export const DEFAULT_CHAT_PORT = 8790;

/** A cap on the request body, so one endless request cannot grow the heap. */
const MAX_BODY_BYTES = 100_000;

export interface ChatServerOptions {
  /** The chatbot to drive. Injected so this server needs no model key of its own. */
  readonly chatbot: Chatbot;
  /** Zero asks the operating system for a free one, which is what tests use. */
  readonly port?: number;
  /** Where the read-only dashboard is, so a run can link to it; omitted if unknown. */
  readonly dashboardUrl?: string;
}

export interface ChatServer {
  /** Where a person points a browser. */
  readonly url: string;
  /** Stops listening. */
  close(): Promise<void>;
}

export async function startChatUi(options: ChatServerOptions): Promise<ChatServer> {
  const page = chatPage(options.dashboardUrl);

  const server = createServer((incoming, outgoing) => {
    handle(incoming, outgoing, options, page).catch((thrown) => {
      // A handler that threw is a server fault, not something the viewer did; a
      // ParaBank URL in the message can carry a session token ADR 0006 classes a
      // Secret, so it is scrubbed the way evidence is before it goes back.
      const message = thrown instanceof Error ? thrown.message : String(thrown);
      json(outgoing, 500, { error: redactSessionIds(message) });
    });
  });

  const port = options.port ?? DEFAULT_CHAT_PORT;
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
  options: ChatServerOptions,
  page: string,
): Promise<void> {
  const path = new URL(incoming.url ?? "/", "http://127.0.0.1").pathname;

  if (incoming.method === "GET" && path === "/") {
    outgoing.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return void outgoing.end(page);
  }

  if (incoming.method === "POST" && path === "/chat") {
    return await chat(incoming, outgoing, options);
  }

  return json(outgoing, 404, { why: "The chatbot has two routes.", page: "GET /", ask: "POST /chat" });
}

async function chat(incoming: IncomingMessage, outgoing: ServerResponse, options: ChatServerOptions): Promise<void> {
  // POST /chat can drive a real mutating capability, so it is guarded the way a
  // state-changing endpoint should be, even on loopback. Requiring a JSON
  // content-type stops a cross-origin form's "simple" request from reaching it
  // without a preflight, and requiring a loopback Host defeats DNS-rebinding —
  // both cheap, and the client-side toggles are no defence since an attacker sets
  // the flags directly.
  const contentType = incoming.headers["content-type"] ?? "";
  if (!contentType.includes("application/json")) {
    return json(outgoing, 415, { error: "POST /chat expects a JSON body (Content-Type: application/json)." });
  }
  if (!hostIsLoopback(incoming)) {
    return json(outgoing, 403, { error: "The chatbot only answers requests addressed to it on loopback." });
  }

  const body = await readJson(incoming);
  if (body.kind === "invalid") return json(outgoing, 400, { error: body.reason });

  const message = body.value["message"];
  if (typeof message !== "string" || message.trim() === "") {
    return json(outgoing, 400, { error: "A chat request needs a non-blank `message`." });
  }

  // The two run choices ride the request as booleans; anything else is ignored.
  // The chatbot applies them (to a mutating step only) — this server does not
  // second-guess it, the same way it enforces no other guardrail. `invocation` is
  // the exact action a confirm is confirming, so the post binds to what the caller
  // was shown rather than a re-derived one.
  const confirmed = readInvocation(body.value["invocation"]);
  const result = await options.chatbot.run(message, {
    preview: body.value["preview"] === true,
    confirmMutating: body.value["confirm"] === true,
    proceed: body.value["proceed"] === true,
    ...(confirmed !== undefined ? { confirmed } : {}),
  });

  return json(outgoing, 200, result);
}

/** The confirmed invocation off the request, when it is the shape the chatbot runs. */
function readInvocation(value: unknown): Invocation | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record["ref"] !== "string") return undefined;
  const inputs = record["inputs"];
  if (typeof inputs !== "object" || inputs === null || Array.isArray(inputs)) return undefined;
  return {
    ref: record["ref"],
    inputs: inputs as Record<string, unknown>,
    ...(typeof record["variant"] === "string" ? { variant: record["variant"] } : {}),
  };
}

/** Whether the request's Host header names a loopback address — the rebinding guard. */
function hostIsLoopback(incoming: IncomingMessage): boolean {
  const host = incoming.headers["host"];
  if (host === undefined) return false;
  // Strip the port; a bracketed IPv6 literal keeps its brackets for the compare.
  const name = host.replace(/:\d+$/, "");
  return name === "127.0.0.1" || name === "localhost" || name === "[::1]" || name === "::1";
}

type Body =
  | { readonly kind: "ok"; readonly value: Record<string, unknown> }
  | { readonly kind: "invalid"; readonly reason: string };

/** The request body as a JSON object. An empty body is no fields, not an error. */
async function readJson(incoming: IncomingMessage): Promise<Body> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of incoming) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) {
      incoming.destroy();
      return { kind: "invalid", reason: "The request body is larger than the chatbot will read." };
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

function json(outgoing: ServerResponse, status: number, body: unknown): void {
  outgoing.writeHead(status, { "content-type": "application/json" });
  outgoing.end(`${JSON.stringify(body, null, 2)}\n`);
}

/** Port zero means the operating system chose; ask it which. */
function listeningPort(server: Server, asked: number): number {
  const address = server.address();
  return typeof address === "object" && address !== null ? address.port : asked;
}
