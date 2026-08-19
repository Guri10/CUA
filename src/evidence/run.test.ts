import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Redaction } from "./redaction.js";
import { EvidenceRun } from "./run.js";

const PASSWORD = "hunter2";

function redaction(masking: "on" | "off" = "on"): Redaction {
  return { secrets: [PASSWORD], sensitive: ["13344"], masking };
}

async function startRun(masking: "on" | "off" = "on"): Promise<EvidenceRun> {
  return await EvidenceRun.start({
    root: await mkdtemp(join(tmpdir(), "cua-evidence-")),
    label: "replay-account-lookup",
    about: { capability: "account-lookup@1", accountId: "13344" },
    redaction: redaction(masking),
  });
}

/** The log as records, which is the form anything reading it would use. */
async function recordsOf(run: EvidenceRun): Promise<Record<string, unknown>[]> {
  const log = await readFile(join(run.directory, "run.jsonl"), "utf8");
  return log
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("an evidence run", () => {
  it("opens a directory of its own", async () => {
    const run = await startRun();

    expect(await readdir(run.directory)).toEqual(["run.jsonl"]);
  });

  it("names the run and its redaction setting in the first record", async () => {
    const run = await startRun();

    expect(await recordsOf(run)).toMatchObject([
      {
        kind: "run-started",
        redaction: "on",
        // Masked, because this run's input is one of its Sensitive values.
        about: { capability: "account-lookup@1", accountId: "[SENSITIVE]" },
      },
    ]);
  });

  it("writes one record per line, in the order they happened", async () => {
    const run = await startRun();
    await run.append({ kind: "action", seq: 0, ms: 4, action: {}, result: {} });
    await run.append({ kind: "action", seq: 1, ms: 7, action: {}, result: {} });
    await run.finish("success", {});

    expect((await recordsOf(run)).map((record) => record["kind"])).toEqual([
      "run-started",
      "action",
      "action",
      "run-finished",
    ]);
  });

  it("stamps every record with the time it was written", async () => {
    const run = await startRun();

    for (const record of await recordsOf(run)) {
      expect(record["at"]).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    }
  });

  it("strips a Secret that reached a record nobody classified", async () => {
    // The backstop ADR 0006 asks for: redaction applied at the boundary, so a
    // value that got into an unclassified field is still not written.
    const run = await startRun("off");
    await run.append({ kind: "action", seq: 0, ms: 1, action: { value: PASSWORD }, result: {} });

    const log = await readFile(join(run.directory, "run.jsonl"), "utf8");
    expect(log).not.toContain(PASSWORD);
    expect(log).toContain("[REDACTED]");
  });

  it("captures the screen when the run fails, and records that it did", async () => {
    const run = await startRun();
    await run.captureFailure(Buffer.from("a png, for the purposes of this test"));

    expect(await readdir(run.directory)).toEqual(expect.arrayContaining(["failure.png"]));
    expect(await recordsOf(run)).toMatchObject([
      { kind: "run-started" },
      { kind: "failure-screenshot", file: "failure.png" },
    ]);
  });

  it("keeps the first failing screen rather than the last", async () => {
    // The decorator captures at the miss and the command captures at the end of
    // the run. The screen that explains the failure is the first one.
    const run = await startRun();
    await run.captureFailure(Buffer.from("the screen that missed"));
    await run.captureFailure(Buffer.from("the screen some steps later"));

    expect(await readFile(join(run.directory, "failure.png"), "utf8")).toBe(
      "the screen that missed",
    );
    expect((await recordsOf(run)).filter((record) => record["kind"] === "failure-screenshot"))
      .toHaveLength(1);
  });

  it("records how the run ended", async () => {
    const run = await startRun();
    await run.finish("hard-failure", { step: "open-account", observed: "no control matched" });

    expect(await recordsOf(run)).toMatchObject([
      { kind: "run-started" },
      {
        kind: "run-finished",
        outcome: "hard-failure",
        about: { step: "open-account", observed: "no control matched" },
      },
    ]);
  });
});
