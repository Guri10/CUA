import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readRunHistory, type RunSummary } from "./history.js";

/**
 * The evidence reader, tested against `run.jsonl` files written by hand in the
 * exact shape the core emits (see `evidence/runs/`). What matters here is that
 * every real ending maps to the right display status, that "recoverable" is
 * derived from what the log already carries rather than invented, and that a
 * partial log — a run that crashed before it finished — reads as incomplete
 * instead of throwing.
 */
describe("run history reader", () => {
  let runsDir = "";

  beforeEach(async () => {
    runsDir = await mkdtemp(join(tmpdir(), "cua-history-"));
  });

  afterEach(async () => {
    await rm(runsDir, { recursive: true, force: true });
  });

  /** Write one run directory with a `run.jsonl` of the given records. */
  async function writeRun(name: string, records: unknown[], extras: string[] = []): Promise<void> {
    const dir = join(runsDir, name);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "run.jsonl"), records.map((r) => JSON.stringify(r)).join("\n") + "\n");
    for (const file of extras) await writeFile(join(dir, file), "x");
  }

  const started = (about: Record<string, string>): unknown => ({
    at: "2026-09-01T00:00:00.000Z",
    kind: "run-started",
    redaction: "on",
    about,
  });
  const finished = (outcome: string, about: Record<string, string> = {}): unknown => ({
    at: "2026-09-01T00:00:05.000Z",
    kind: "run-finished",
    outcome,
    about,
  });

  const byId = (runs: RunSummary[], id: string): RunSummary => {
    const found = runs.find((r) => r.id === id);
    if (found === undefined) throw new Error(`no run ${id}`);
    return found;
  };

  it("maps every real outcome to its display status", async () => {
    await writeRun("2026-09-01T00-00-00.000Z-replay-account-lookup-a", [
      started({ capability: "account-lookup@1" }),
      finished("success"),
    ]);
    await writeRun("2026-09-01T00-00-01.000Z-replay-account-lookup-b", [
      started({ capability: "account-lookup@1" }),
      finished("business-outcome", { outcome: "ACCOUNT_NOT_FOUND", step: "wait-for-link" }),
    ]);
    await writeRun("2026-09-01T00-00-02.000Z-replay-account-lookup-c", [
      started({ capability: "account-lookup@1" }),
      finished("hard-failure", { step: "read-balance", observed: "no control matched" }),
    ]);
    await writeRun("2026-09-01T00-00-03.000Z-discover-d", [
      started({ goal: "move money" }),
      finished("intervention-request", { reason: "no mandate" }),
    ]);
    await writeRun("2026-09-01T00-00-04.000Z-discover-e", [
      started({ goal: "something" }),
      finished("stopped", { because: "out of steps" }),
    ]);

    const runs = await readRunHistory(runsDir);

    expect(byId(runs, "2026-09-01T00-00-00.000Z-replay-account-lookup-a").status).toBe("success");
    expect(byId(runs, "2026-09-01T00-00-01.000Z-replay-account-lookup-b").status).toBe("business-outcome");
    expect(byId(runs, "2026-09-01T00-00-02.000Z-replay-account-lookup-c").status).toBe("failed");
    expect(byId(runs, "2026-09-01T00-00-03.000Z-discover-d").status).toBe("escalated");
    expect(byId(runs, "2026-09-01T00-00-04.000Z-discover-e").status).toBe("stopped");
  });

  it("derives a recovered success from the recovered marker the log carries", async () => {
    await writeRun("2026-09-01T00-00-00.000Z-replay-account-lookup-r", [
      started({ capability: "account-lookup@1", injected: "SESSION_EXPIRED" }),
      finished("success", { recovered: "SESSION_EXPIRED" }),
    ]);

    const [run] = await readRunHistory(runsDir);

    expect(run!.status).toBe("recovered");
    expect(run!.recoveredFrom).toBe("SESSION_EXPIRED");
  });

  it("derives recovered from a success that captured a failure screen, even with no marker", async () => {
    // The live recovery path writes `finish(\"success\", {})` — no marker — but a
    // run that recovered captured the screen it faulted on before retrying. A
    // plain success never misses an Action, so a success with a screenshot is a
    // recovered run.
    await writeRun(
      "2026-09-01T00-00-00.000Z-replay-account-lookup-s",
      [
        started({ capability: "account-lookup@1" }),
        { at: "t", kind: "action", seq: 0, action: { kind: "waitFor" }, result: { kind: "not-found" } },
        { at: "t", kind: "failure-screenshot", file: "failure.png" },
        finished("success", {}),
      ],
      ["failure.png"],
    );

    const [run] = await readRunHistory(runsDir);

    expect(run!.status).toBe("recovered");
    expect(run!.recoveredFrom).toBeUndefined();
  });

  it("reads a run with no run-finished record as incomplete rather than throwing", async () => {
    await writeRun("2026-09-01T00-00-00.000Z-replay-account-lookup-x", [
      started({ capability: "account-lookup@1" }),
      { at: "2026-09-01T00:00:01.000Z", kind: "action", seq: 0, action: {}, result: {} },
    ]);

    const [run] = await readRunHistory(runsDir);

    expect(run!.status).toBe("incomplete");
    expect(run!.finishedAt).toBeUndefined();
  });

  it("classifies discovery and replay runs from the directory name", async () => {
    await writeRun("2026-09-01T00-00-00.000Z-replay-account-lookup-a", [started({}), finished("success")]);
    await writeRun("2026-09-01T00-00-01.000Z-discover", [started({}), finished("stopped")]);

    const runs = await readRunHistory(runsDir);

    expect(byId(runs, "2026-09-01T00-00-00.000Z-replay-account-lookup-a").kind).toBe("replay");
    expect(byId(runs, "2026-09-01T00-00-01.000Z-discover").kind).toBe("discovery");
  });

  it("pulls inputs off the run-started record and result details off the finish", async () => {
    await writeRun("2026-09-01T00-00-00.000Z-replay-account-lookup-i", [
      started({ capability: "account-lookup@1", baseUrl: "http://x", "input.accountId": "[SENSITIVE]" }),
      finished("business-outcome", { outcome: "ACCOUNT_NOT_FOUND", step: "wait-for-link" }),
    ]);

    const [run] = await readRunHistory(runsDir);

    expect(run!.capability).toBe("account-lookup@1");
    expect(run!.inputs).toEqual([{ name: "accountId", value: "[SENSITIVE]" }]);
    expect(run!.businessOutcome).toBe("ACCOUNT_NOT_FOUND");
    expect(run!.result).toContainEqual({ name: "step", value: "wait-for-link" });
  });

  it("counts the typed values read and the actions taken, and notes a failure screenshot", async () => {
    await writeRun(
      "2026-09-01T00-00-00.000Z-replay-account-lookup-o",
      [
        started({ capability: "account-lookup@1" }),
        { at: "t", kind: "action", seq: 0, action: { kind: "click" }, result: { kind: "ok" } },
        { at: "t", kind: "action", seq: 1, action: { kind: "read" }, result: { kind: "ok", value: "[SENSITIVE]" } },
        { at: "t", kind: "action", seq: 2, action: { kind: "read" }, result: { kind: "ok", value: "[SENSITIVE]" } },
        { at: "t", kind: "failure-screenshot", file: "failure.png" },
        finished("success"),
      ],
      ["failure.png"],
    );

    const [run] = await readRunHistory(runsDir);

    expect(run!.actionCount).toBe(3);
    expect(run!.readCount).toBe(2);
    expect(run!.hasFailureScreenshot).toBe(true);
  });

  it("returns newest first and ignores non-run entries like the README", async () => {
    await writeRun("2026-09-01T00-00-00.000Z-replay-a", [started({}), finished("success")]);
    await writeRun("2026-09-02T00-00-00.000Z-replay-b", [started({}), finished("success")]);
    await writeFile(join(runsDir, "README.md"), "# not a run");

    const runs = await readRunHistory(runsDir);

    expect(runs.map((r) => r.id)).toEqual([
      "2026-09-02T00-00-00.000Z-replay-b",
      "2026-09-01T00-00-00.000Z-replay-a",
    ]);
  });

  it("is empty, not an error, when there are no runs at all", async () => {
    expect(await readRunHistory(runsDir)).toEqual([]);
  });

  it("skips a malformed line rather than failing the whole run", async () => {
    const dir = join(runsDir, "2026-09-01T00-00-00.000Z-replay-account-lookup-m");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "run.jsonl"),
      [JSON.stringify(started({ capability: "account-lookup@1" })), "{ not json", JSON.stringify(finished("success"))].join("\n") + "\n",
    );

    const [run] = await readRunHistory(runsDir);

    expect(run!.status).toBe("success");
    expect(run!.capability).toBe("account-lookup@1");
  });
});
