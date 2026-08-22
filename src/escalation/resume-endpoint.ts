/**
 * The way a person says they are finished.
 *
 * The spec is explicit that the operator's interface is "the already-open
 * browser window plus a resume call, not a built UI" — a real console is named
 * out of scope. What is left still has to be something a person can actually
 * reach, and a paused Node process reading its own stdin is not it: the run is
 * headed, so the operator is in the browser window, and the terminal the run
 * started in may be a scrollback three screens up or another machine's ssh
 * session entirely.
 *
 * So it is one small HTTP server, on loopback, holding exactly two things: the
 * Intervention Request, and the way to give control back. It opens when the run
 * pauses and closes when control returns, which is deliberate rather than
 * incidental — an endpoint that outlived the pause would be a resume waiting to
 * be replayed against whatever the run was doing an hour later.
 *
 * Loopback only, and no authentication. That is the spec's "taking control
 * assumes the human is at the same machine", made literal: binding to
 * 127.0.0.1 is what makes the assumption a property of the socket rather than a
 * sentence in a document. Serving the observed accessibility tree over it is
 * safe on the same grounds — the person reading it is looking at that screen.
 */
import { createServer, type Server } from "node:http";
import type { SessionControl } from "./controller.js";
import type { InterventionRequest } from "./intervention-request.js";

/**
 * Fixed rather than picked from whatever is free, so the README can print a
 * command that works. A port already in use fails the pause loudly instead of
 * moving somewhere the operator was not told about.
 */
export const DEFAULT_RESUME_PORT = 8787;

export interface ResumeEndpoint {
  /** Where the operator points curl. Printed when the run pauses. */
  readonly url: string;
  /**
   * Resolves when a person has asked for the run to continue, and rejects if
   * the server faults after it began listening — so a paused run awaiting this
   * is told rather than left hanging on a socket that will never carry a resume.
   */
  readonly resumed: Promise<void>;
  /** Stops listening. Called when control returns, however it returned. */
  close(): Promise<void>;
}

export interface ResumeEndpointOptions {
  readonly control: SessionControl;
  readonly request: InterventionRequest;
  /** Zero asks the operating system for a free one, which is what tests use. */
  readonly port?: number;
}

/**
 * Opens the endpoint and starts listening.
 *
 * `GET /` is the Intervention Request, as JSON — the same four things
 * CONTEXT.md says it carries, so an operator who came to the machine cold can
 * read what stopped without going through the run directory. `POST /resume`
 * hands control back and settles `resumed`.
 *
 * The transition itself is the SessionControl's, not this module's. Two things
 * change state when a run resumes — who may act, and whether this server is
 * listening — and having the endpoint make the transition while something else
 * decided to close it is how those two drift apart.
 */
export async function openResumeEndpoint(options: ResumeEndpointOptions): Promise<ResumeEndpoint> {
  let announceResumed: () => void = () => {};
  let failResumed: (error: unknown) => void = () => {};
  const resumed = new Promise<void>((resolve, reject) => {
    announceResumed = resolve;
    failResumed = reject;
  });

  const server = createServer((incoming, outgoing) => {
    const path = (incoming.url ?? "/").split("?")[0];

    if (incoming.method === "GET" && path === "/") {
      return reply(outgoing, 200, options.request);
    }

    if (incoming.method === "POST" && path === "/resume") {
      if (options.control.controller === "agent") {
        // Already back. Answered rather than repeated, because a second resume
        // would be a transition the Controller refuses — and a curl retried
        // after a flaky connection should not crash a run that is going again.
        return reply(outgoing, 409, { resumed: false, why: "Control is already the agent's." });
      }
      options.control.toAgent();
      announceResumed();
      return reply(outgoing, 200, { resumed: true });
    }

    return reply(outgoing, 404, {
      why: "This endpoint holds one Intervention Request.",
      read: "GET /",
      resume: "POST /resume",
    });
  });

  const port = options.port ?? DEFAULT_RESUME_PORT;
  await new Promise<void>((resolve, reject) => {
    // Only until listening: a bind failure (the port already in use) rejects
    // the open. Removed once we are listening so it is not left to reject an
    // already-settled promise — a later fault is the durable handler's job.
    const onStartupError = (error: Error): void => reject(error);
    server.once("error", onStartupError);
    server.listen(port, "127.0.0.1", () => {
      server.removeListener("error", onStartupError);
      // Durable, so a server fault after we are listening reaches the paused
      // run instead of being swallowed: the run is awaiting `resumed`, and a
      // rejection there tears the handover down rather than hanging on a socket
      // that will never carry a resume.
      server.on("error", (error) => failResumed(error));
      resolve();
    });
  });

  const endpoint: ResumeEndpoint = {
    url: `http://127.0.0.1:${listeningPort(server, port)}`,
    resumed,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
  // The server is attached but kept out of the public `ResumeEndpoint` type, so
  // a caller cannot reach past the endpoint and close or re-wire it out from
  // under the lifecycle this owns. A test reaches it by cast to drive a
  // post-listen fault, which there is otherwise no external way to raise.
  return Object.assign(endpoint, { server });
}

function reply(
  outgoing: { writeHead(code: number, headers: Record<string, string>): void; end(body: string): void },
  status: number,
  body: unknown,
): void {
  // `Connection: close` so a reader's socket ends with the response rather than
  // lingering as an idle keep-alive one. On a runtime whose `server.close()`
  // waits for idle keep-alive sockets, one left open by a reader would hold the
  // close until the keep-alive timeout (~5s) and delay the resume the endpoint
  // exists to make prompt; current Node closes such sockets itself, but ending
  // them at the source makes the guarantee hold regardless, and the endpoint is
  // one-shot — read, then resume — so a kept-alive socket saves nothing.
  outgoing.writeHead(status, { "content-type": "application/json", connection: "close" });
  outgoing.end(`${JSON.stringify(body, null, 2)}\n`);
}

/** Port zero means the operating system chose; ask it which. */
function listeningPort(server: Server, asked: number): number {
  const address = server.address();
  return typeof address === "object" && address !== null ? address.port : asked;
}
