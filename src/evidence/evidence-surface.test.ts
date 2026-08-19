import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FakeSurface } from "../surface/fake-surface.js";
import { parabankScript } from "../surface/parabank/fake-script.js";
import { EvidenceSurface } from "./evidence-surface.js";
import type { Redaction } from "./redaction.js";
import { EvidenceRun } from "./run.js";

const PASSWORD = "hunter2";
/** The account the committed snapshots were captured against. */
const CAPTURED_ACCOUNT = "12345";

function redaction(masking: "on" | "off" = "on"): Redaction {
  return { secrets: [PASSWORD], sensitive: [CAPTURED_ACCOUNT], masking };
}

async function logged(masking: "on" | "off" = "on") {
  const run = await EvidenceRun.start({
    root: await mkdtemp(join(tmpdir(), "cua-evidence-")),
    label: "test",
    about: {},
    redaction: redaction(masking),
  });

  return { run, surface: new EvidenceSurface(new FakeSurface(parabankScript()), run) };
}

async function actionsIn(run: EvidenceRun): Promise<Record<string, unknown>[]> {
  const log = await readFile(join(run.directory, "run.jsonl"), "utf8");
  return log
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((record) => record["kind"] === "action");
}

describe("the evidence decorator", () => {
  it("logs every Action and what it returned", async () => {
    const { run, surface } = await logged();

    await surface.perform({ kind: "navigate", url: "http://localhost:8080/parabank/index.htm" });

    expect(await actionsIn(run)).toMatchObject([
      {
        seq: 0,
        action: { kind: "navigate", url: "http://localhost:8080/parabank/index.htm" },
        result: { kind: "ok" },
      },
    ]);
  });

  it("numbers Actions in the order they were taken", async () => {
    const { run, surface } = await logged();

    await surface.perform({ kind: "navigate", url: "http://localhost:8080/parabank/index.htm" });
    await surface.perform({ kind: "waitFor", locator: { role: "textbox", ordinal: 0 } });

    expect((await actionsIn(run)).map((record) => record["seq"])).toEqual([0, 1]);
  });

  it("never writes the password a fill typed, whatever the setting", async () => {
    for (const masking of ["on", "off"] as const) {
      const { run, surface } = await logged(masking);

      await surface.perform({
        kind: "fill",
        locator: { role: "textbox", ordinal: 1 },
        value: PASSWORD,
      });

      const log = await readFile(join(run.directory, "run.jsonl"), "utf8");
      expect(log).not.toContain(PASSWORD);
    }
  });

  it("masks what a read returned, and hands the caller the value in full", async () => {
    const { run, surface } = await logged();
    await surface.perform({ kind: "navigate", url: "http://localhost:8080/parabank/overview.htm" });
    await surface.perform({ kind: "click", locator: { role: "link", name: CAPTURED_ACCOUNT, exact: true } });

    const read = await surface.perform({
      kind: "read",
      locator: { role: "cell", ordinal: 1, within: { role: "row", name: "Balance:" } },
    });

    // ADR 0006: masked in what is stored, intact in what is returned.
    expect(read).toEqual({ kind: "ok", value: "-$2300.00" });
    expect(await actionsIn(run)).toMatchObject([
      {},
      {},
      { action: { kind: "read" }, result: { kind: "ok", value: "[SENSITIVE]" } },
    ]);
  });

  it("writes the read value in full when redaction is off", async () => {
    const { run, surface } = await logged("off");
    await surface.perform({ kind: "navigate", url: "http://localhost:8080/parabank/overview.htm" });
    await surface.perform({ kind: "click", locator: { role: "link", name: CAPTURED_ACCOUNT, exact: true } });
    await surface.perform({
      kind: "read",
      locator: { role: "cell", ordinal: 1, within: { role: "row", name: "Balance:" } },
    });

    expect((await actionsIn(run)).at(-1)).toMatchObject({ result: { value: "-$2300.00" } });
  });

  it("masks an account number this run substituted into a Locator", async () => {
    const { run, surface } = await logged();

    await surface.perform({
      kind: "click",
      locator: { role: "link", name: CAPTURED_ACCOUNT, exact: true },
    });

    expect(await actionsIn(run)).toMatchObject([
      { action: { locator: { role: "link", name: "[SENSITIVE]", exact: true } } },
    ]);
  });

  it("captures the screen when an Action misses", async () => {
    const { run, surface } = await logged();

    await surface.perform({ kind: "click", locator: { role: "link", name: "nothing here" } });

    expect(await readdir(run.directory)).toEqual(expect.arrayContaining(["failure.png"]));
  });

  it("does not capture a screen for an Action that worked", async () => {
    const { run, surface } = await logged();

    await surface.perform({ kind: "navigate", url: "http://localhost:8080/parabank/index.htm" });

    expect(await readdir(run.directory)).toEqual(["run.jsonl"]);
  });

  it("passes observation straight through, and does not log a tree full of balances", async () => {
    const { run, surface } = await logged();

    await surface.perform({ kind: "navigate", url: "http://localhost:8080/parabank/overview.htm" });
    const snapshot = await surface.snapshot();

    // The tree is there for the caller and nowhere in the log: one Action was
    // taken, one record was written, and no balance came with it.
    expect(snapshot.tree).toContain("$");
    expect(await actionsIn(run)).toHaveLength(1);
    expect(await readFile(join(run.directory, "run.jsonl"), "utf8")).not.toContain("-$2300.00");
  });

  it("passes a screenshot straight through", async () => {
    const { surface } = await logged();

    expect((await surface.screenshot()).toString()).toContain("fake screenshot");
  });
});
