/**
 * The dashboard over HTTP: a person points a browser at it and watches the
 * system work. It reads the two things the core already writes — the approved
 * Capability catalog and the evidence runs — and answers GETs with a rendered
 * page. It is not a second boundary and owns no risk: the catalog server (ADR
 * 0007) is where effects and approval are decided, and this server invokes
 * nothing, so the strongest thing it can do to the world is show a stale page.
 *
 * Read-only is enforced, not merely intended: anything but GET is refused with a
 * 405 before it can reach any handler, so there is no write path to get wrong.
 *
 * Two routes:
 *
 *   GET /                         the dashboard page
 *   GET /runs/:id/failure.png     one run's captured screen
 *
 * The screenshot route is the one place this server reads a file named in the
 * request, so `:id` is constrained to a single path segment — no separator and no
 * dot-prefix, checked after decoding — which is what keeps `../` and its
 * encodings from escaping the runs directory. A run directory always begins with
 * a digit (its ISO year), so the dot-prefix rule never rejects a real one. It is
 * a separate concern from redaction: the screen is pixels and carries whatever it
 * carried on disk (ADR 0006's one place evidence holds a Sensitive value), so
 * this route serves exactly the committed evidence, no more.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { listCatalog } from "../catalog/catalog.js";
import { redactSessionIds } from "../evidence/redact-session-ids.js";
import { readRunHistory } from "./history.js";
import { renderDashboard } from "./render.js";

/**
 * Fixed rather than picked at random, so a README can print a URL that works.
 * The catalog reserves 8788 and the resume endpoint 8787; this is the
 * dashboard's, adjacent so the three read as one installation's ports.
 */
export const DEFAULT_DASHBOARD_PORT = 8789;

/** The screenshot each run captures, if any. Matches `src/evidence/run.ts`. */
const SCREENSHOT_FILE = "failure.png";

export interface DashboardServerOptions {
  /** Where the Capabilities are — the same root the catalog server reads. */
  readonly capabilitiesRoot: string;
  /** Where the evidence runs are — `evidenceRunsDir()` in the command. */
  readonly runsDir: string;
  /** Zero asks the operating system for a free one, which is what tests use. */
  readonly port?: number;
}

export interface DashboardServer {
  /** Where a person points a browser. */
  readonly url: string;
  /** Stops listening. */
  close(): Promise<void>;
}

export async function startDashboard(options: DashboardServerOptions): Promise<DashboardServer> {
  const server = createServer((incoming, outgoing) => {
    handle(incoming, outgoing, options).catch((thrown) => {
      // A handler that threw is a server fault, not something the viewer did. A
      // ParaBank URL in the message can carry a session token ADR 0006 classes a
      // Secret, so it is scrubbed the way evidence is before it goes back.
      const message = thrown instanceof Error ? thrown.message : String(thrown);
      text(outgoing, 500, redactSessionIds(message));
    });
  });

  const port = options.port ?? DEFAULT_DASHBOARD_PORT;
  await new Promise<void>((resolve, reject) => {
    const onStartupError = (error: Error): void => reject(error);
    server.once("error", onStartupError);
    server.listen(port, "127.0.0.1", () => {
      server.removeListener("error", onStartupError);
      resolve();
    });
  });

  const address = server.address();
  const boundPort = typeof address === "object" && address !== null ? address.port : port;
  return {
    url: `http://127.0.0.1:${boundPort}`,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function handle(
  incoming: IncomingMessage,
  outgoing: ServerResponse,
  options: DashboardServerOptions,
): Promise<void> {
  // Read-only, enforced first: nothing but GET reaches a handler, so there is no
  // write path to get wrong.
  if (incoming.method !== "GET") {
    return text(outgoing, 405, "The dashboard is read-only. Only GET is allowed.\n");
  }

  const path = new URL(incoming.url ?? "/", "http://127.0.0.1").pathname;

  if (path === "/") return await page(outgoing, options);

  const runId = screenshotRunId(path);
  if (runId !== undefined) return await screenshot(outgoing, options, runId);

  return text(outgoing, 404, "The dashboard has two routes: GET / and GET /runs/<id>/failure.png\n");
}

async function page(outgoing: ServerResponse, options: DashboardServerOptions): Promise<void> {
  const [catalog, runs] = await Promise.all([
    listCatalog(options.capabilitiesRoot),
    readRunHistory(options.runsDir),
  ]);
  const html = renderDashboard({ catalog, runs, generatedAt: new Date().toISOString() });
  outgoing.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  outgoing.end(html);
}

/** `/runs/<id>/failure.png` → the decoded `<id>`, or undefined if not that shape. */
function screenshotRunId(path: string): string | undefined {
  const match = /^\/runs\/([^/]+)\/failure\.png$/.exec(path);
  return match === null ? undefined : decodeURIComponent(match[1]!);
}

async function screenshot(
  outgoing: ServerResponse,
  options: DashboardServerOptions,
  runId: string,
): Promise<void> {
  // A single directory segment and nothing else: no separator (so `../` cannot
  // climb) and no leading dot (so `.` and `..` are out), both checked on the
  // decoded id. `basename` collapses any path parts, so an id that survives it
  // unchanged has none. A run whose screen does not exist reads as a 404 from the
  // read below, so there is no need to scan the whole history to know it.
  if (runId !== basename(runId) || runId === "" || runId.startsWith(".")) {
    return text(outgoing, 404, "No screenshot for that run.\n");
  }

  let bytes: Buffer;
  try {
    bytes = await readFile(join(options.runsDir, runId, SCREENSHOT_FILE));
  } catch {
    return text(outgoing, 404, "No screenshot for that run.\n");
  }
  outgoing.writeHead(200, { "content-type": "image/png" });
  outgoing.end(bytes);
}

function text(outgoing: ServerResponse, status: number, body: string): void {
  outgoing.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  outgoing.end(body);
}
