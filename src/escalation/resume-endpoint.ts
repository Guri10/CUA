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
  /** Resolves when a person has asked for the run to continue. */
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
  const resumed = new Promise<void>((resolve) => {
    announceResumed = resolve;
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
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });

  return {
    url: `http://127.0.0.1:${listeningPort(server, port)}`,
    resumed,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function reply(
  outgoing: { writeHead(code: number, headers: Record<string, string>): void; end(body: string): void },
  status: number,
  body: unknown,
): void {
  outgoing.writeHead(status, { "content-type": "application/json" });
  outgoing.end(`${JSON.stringify(body, null, 2)}\n`);
}

/** Port zero means the operating system chose; ask it which. */
function listeningPort(server: Server, asked: number): number {
  const address = server.address();
  return typeof address === "object" && address !== null ? address.port : asked;
}
