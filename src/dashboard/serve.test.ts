import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { accountLookupCapability } from "../capability/parabank/account-lookup.js";
import type { Capability } from "../capability/schema.js";
import { saveCapability } from "../capability/storage.js";
import { startDashboard, type DashboardServer } from "./serve.js";

/**
 * The dashboard server. It reads two directories and answers GETs; it must never
 * accept a write, and it must not serve a file outside the runs it knows about.
 * Those two properties — read-only, and no path escaping the runs directory — are
 * what these tests hold; the HTML itself is `render`'s test.
 */
describe("dashboard server", () => {
  let capabilitiesRoot = "";
  let runsDir = "";
  let server: DashboardServer | undefined;

  const approved = (capability: Capability): Capability => ({ ...capability, approval: "approved" });

  async function writeRun(name: string, records: unknown[], files: Record<string, string> = {}): Promise<void> {
    const dir = join(runsDir, name);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "run.jsonl"), records.map((r) => JSON.stringify(r)).join("\n") + "\n");
    for (const [file, content] of Object.entries(files)) await writeFile(join(dir, file), content);
  }

  async function serve(): Promise<string> {
    server = await startDashboard({ capabilitiesRoot, runsDir, port: 0 });
    return server.url;
  }

  beforeEach(async () => {
    capabilitiesRoot = await mkdtemp(join(tmpdir(), "cua-dash-caps-"));
    runsDir = await mkdtemp(join(tmpdir(), "cua-dash-runs-"));
  });

  afterEach(async () => {
    await server?.close();
    server = undefined;
    await rm(capabilitiesRoot, { recursive: true, force: true });
    await rm(runsDir, { recursive: true, force: true });
  });

  it("serves the dashboard as HTML at the root", async () => {
    await saveCapability(capabilitiesRoot, approved(accountLookupCapability()));
    await writeRun("2026-09-01T00-00-00.000Z-replay-account-lookup-a", [
      { at: "t", kind: "run-started", redaction: "on", about: { capability: "account-lookup@1" } },
      { at: "t", kind: "run-finished", outcome: "success", about: {} },
    ]);
    const url = await serve();

    const response = await fetch(`${url}/`);
    const text = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/text\/html/);
    expect(text).toContain("account-lookup");
    expect(text).toContain("Success");
  });

  it("renders sensibly with an empty catalog and no runs", async () => {
    const url = await serve();

    const response = await fetch(`${url}/`);
    const text = await response.text();

    expect(response.status).toBe(200);
    expect(text).toMatch(/no approved capabilities/i);
    expect(text).toMatch(/no runs/i);
  });

  it("does not list a draft in the served catalog", async () => {
    await saveCapability(capabilitiesRoot, accountLookupCapability()); // draft by default
    const url = await serve();

    const text = await (await fetch(`${url}/`)).text();

    expect(text).toMatch(/no approved capabilities/i);
  });

  it("serves a run's failure screenshot as an image", async () => {
    await writeRun(
      "2026-09-01T00-00-00.000Z-replay-account-lookup-f",
      [
        { at: "t", kind: "run-started", redaction: "on", about: { capability: "account-lookup@1" } },
        { at: "t", kind: "failure-screenshot", file: "failure.png" },
        { at: "t", kind: "run-finished", outcome: "hard-failure", about: { step: "read-balance" } },
      ],
      { "failure.png": "PNGBYTES" },
    );
    const url = await serve();

    const response = await fetch(`${url}/runs/${encodeURIComponent("2026-09-01T00-00-00.000Z-replay-account-lookup-f")}/failure.png`);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/image\/png/);
    expect(await response.text()).toBe("PNGBYTES");
  });

  it("answers 404 for a screenshot on a run that has none", async () => {
    await writeRun("2026-09-01T00-00-00.000Z-replay-account-lookup-n", [
      { at: "t", kind: "run-started", redaction: "on", about: {} },
      { at: "t", kind: "run-finished", outcome: "success", about: {} },
    ]);
    const url = await serve();

    const response = await fetch(`${url}/runs/2026-09-01T00-00-00.000Z-replay-account-lookup-n/failure.png`);

    expect(response.status).toBe(404);
  });

  it("answers 404 for a screenshot on an unknown run", async () => {
    const url = await serve();
    expect((await fetch(`${url}/runs/no-such-run/failure.png`)).status).toBe(404);
  });

  it("does not serve a file outside the runs it knows, however the id is dressed up", async () => {
    // A real secret to try to escape to, one directory up from the runs dir.
    await writeFile(join(runsDir, "..", "outside.txt"), "SECRET");
    const url = await serve();

    for (const id of ["..", "%2e%2e", "..%2ffailure.png", "..%2f..%2foutside.txt"]) {
      const response = await fetch(`${url}/runs/${id}/failure.png`);
      expect(response.status).toBe(404);
    }
    await rm(join(runsDir, "..", "outside.txt"), { force: true });
  });

  it("refuses a write: only GET is read-only", async () => {
    const url = await serve();

    for (const method of ["POST", "PUT", "DELETE"]) {
      const response = await fetch(`${url}/`, { method });
      expect(response.status).toBe(405);
    }
  });

  it("answers 404 for an unknown route", async () => {
    const url = await serve();
    expect((await fetch(`${url}/nope`)).status).toBe(404);
  });
});
