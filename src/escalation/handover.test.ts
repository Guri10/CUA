import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EvidenceRun } from "../evidence/run.js";
import type { Action } from "../surface/surface.js";
import { SessionControl } from "./controller.js";
import { handOverToHuman, type StopCapture } from "./handover.js";
import type { InterventionRequest } from "./intervention-request.js";

const PASSWORD = "not-the-real-one";

const REQUEST: InterventionRequest = {
  capability: "open-account@1",
  step: "click Open New Account",
  reason: `"/openaccount.htm" can change data, and this run has no mandate to.`,
  observed: {
    url: "http://localhost:8080/parabank/openaccount.htm;jsessionid=ABC123",
    tree: `- heading "Open New Account"`,
  },
};

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function startRun(masking: "on" | "off" = "on"): Promise<EvidenceRun> {
  const root = await mkdtemp(join(tmpdir(), "cua-handover-"));
  roots.push(root);
  return await EvidenceRun.start({
    root,
    label: "escalation",
    about: { capability: "open-account@1" },
    redaction: { secrets: [PASSWORD], sensitive: ["12345"], masking },
  });
}

async function recordsOf(run: EvidenceRun): Promise<Record<string, unknown>[]> {
  const log = await readFile(join(run.directory, "run.jsonl"), "utf8");
  return log.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
}

/**
 * The person, played by the test: a capture that hands back a way to feed in
 * the Actions they took, and a resume that arrives over the endpoint the way an
 * operator's would.
 */
function humanWho(...actions: Action[]): {
  capture: (onAction: (action: Action) => void) => Promise<StopCapture>;
  stopped: () => boolean;
} {
  let wasStopped = false;
  return {
    capture: async (onAction) => {
      for (const action of actions) onAction(action);
      return async () => {
        wasStopped = true;
      };
    },
    stopped: () => wasStopped,
  };
}

/** Reads the URL out of what the operator was told, and resumes through it. */
async function resumeThrough(announced: string[]): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const url = announced.join("\n").match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
    if (url !== undefined) {
      const response = await fetch(`${url}/resume`, { method: "POST" });
      expect(response.status).toBe(200);
      return;
    }
    await new Promise((settle) => setTimeout(settle, 10));
  }
  throw new Error("The pause never announced an endpoint to resume through.");
}

describe("handing the live session to a person", () => {
  it("waits for the person, and continues once they say so", async () => {
    const control = new SessionControl();
    const evidence = await startRun();
    const announced: string[] = [];
    const human = humanWho({ kind: "click", locator: { role: "button", name: "Open New Account" } });

    const handover = handOverToHuman({
      control,
      evidence,
      request: REQUEST,
      capture: human.capture,
      port: 0,
      announce: (message) => announced.push(message),
    });

    await resumeThrough(announced);
    const { actions } = await handover;

    expect(control.controller).toBe("agent");
    expect(actions).toEqual([
      { kind: "click", locator: { role: "button", name: "Open New Account" } },
    ]);
    // Nobody is left recording a session the agent is driving.
    expect(human.stopped()).toBe(true);
  });

  it("tells the operator what stopped and how to give control back", async () => {
    const evidence = await startRun();
    const announced: string[] = [];

    const handover = handOverToHuman({
      control: new SessionControl(),
      evidence,
      request: REQUEST,
      capture: humanWho().capture,
      port: 0,
      announce: (message) => announced.push(message),
    });
    await resumeThrough(announced);
    await handover;

    const message = announced.join("\n");
    // The four things CONTEXT.md says an Intervention Request carries, where
    // the operator will actually read them — the spec puts a built console out
    // of scope, so this message and the browser window are the whole interface.
    expect(message).toContain("open-account@1");
    expect(message).toContain("click Open New Account");
    expect(message).toContain("can change data");
    expect(message).toMatch(/curl -X POST http:\/\/127\.0\.0\.1:\d+\/resume/);
    // ADR 0006 classes ParaBank's session token a Secret, and this line is
    // printed to a terminal that is very often pasted into a ticket.
    expect(message).not.toContain("ABC123");
  });

  it("writes the escalation, both handovers, and what the person did", async () => {
    const control = new SessionControl();
    const evidence = await startRun();
    const announced: string[] = [];

    const handover = handOverToHuman({
      control,
      evidence,
      request: REQUEST,
      capture: humanWho(
        { kind: "select", locator: { role: "combobox", name: "Account Type" }, option: "SAVINGS" },
        { kind: "click", locator: { role: "button", name: "Open New Account" } },
      ).capture,
      port: 0,
      announce: (message) => announced.push(message),
    });
    await resumeThrough(announced);
    await handover;

    const records = await recordsOf(evidence);
    expect(records.map((record) => record["kind"])).toEqual([
      "run-started",
      // Why control moved, and then control moving. In that order, because a
      // trail that says the human took over without saying why is the one an
      // auditor cannot use.
      "intervention-request",
      "control",
      "action",
      "action",
      "control",
    ]);
    expect(records[1]).toMatchObject({
      capability: "open-account@1",
      step: "click Open New Account",
      screen: "http://localhost:8080/parabank/openaccount.htm;jsessionid=[REDACTED]",
    });
    expect(records[2]).toMatchObject({ to: "human" });
    expect(records.at(-1)).toMatchObject({ to: "agent" });
  });

  it("attributes every one of the person's Actions to the human", async () => {
    const evidence = await startRun();
    const announced: string[] = [];

    const handover = handOverToHuman({
      control: new SessionControl(),
      evidence,
      request: REQUEST,
      capture: humanWho(
        { kind: "fill", locator: { role: "textbox", ordinal: 0 }, value: "12345" },
        { kind: "click", locator: { role: "button", name: "Open New Account" } },
      ).capture,
      port: 0,
      announce: (message) => announced.push(message),
    });
    await resumeThrough(announced);
    await handover;

    const acted = (await recordsOf(evidence)).filter((record) => record["kind"] === "action");
    // The auditor's user story: every action, by whom.
    expect(acted.map((record) => record["by"])).toEqual(["human", "human"]);
    // Numbered from the run's own sequence, so the person's Actions interleave
    // with the agent's in one countable order rather than in a second list.
    expect(acted.map((record) => record["seq"])).toEqual([0, 1]);
  });

  it("masks what the person typed by the same rules as what the agent types", async () => {
    const evidence = await startRun();
    const announced: string[] = [];

    const handover = handOverToHuman({
      control: new SessionControl(),
      evidence,
      request: REQUEST,
      capture: humanWho(
        // This run's own declared input, and the application password. ADR 0006
        // masks the first when redaction is on and never writes the second.
        { kind: "fill", locator: { role: "textbox", ordinal: 0 }, value: "12345" },
        { kind: "fill", locator: { role: "textbox", ordinal: 1 }, value: PASSWORD },
      ).capture,
      port: 0,
      announce: (message) => announced.push(message),
    });
    await resumeThrough(announced);
    await handover;

    const log = await readFile(join(evidence.directory, "run.jsonl"), "utf8");
    expect(log).not.toContain(PASSWORD);
    expect(log).toContain("[REDACTED]");
    expect(log).toContain("[SENSITIVE]");
    expect(log).not.toContain("12345");
  });

  it("closes the endpoint once control is back", async () => {
    const evidence = await startRun();
    const announced: string[] = [];

    const handover = handOverToHuman({
      control: new SessionControl(),
      evidence,
      request: REQUEST,
      capture: humanWho().capture,
      port: 0,
      announce: (message) => announced.push(message),
    });
    await resumeThrough(announced);
    await handover;

    const url = announced.join("\n").match(/http:\/\/127\.0\.0\.1:\d+/)![0];
    await expect(fetch(url)).rejects.toThrow();
  });
});

describe("a run that escalates twice", () => {
  it("writes each handover once", async () => {
    const control = new SessionControl();
    const evidence = await startRun();

    for (const _ of [0, 1]) {
      const announced: string[] = [];
      const handover = handOverToHuman({
        control,
        evidence,
        request: REQUEST,
        capture: humanWho({ kind: "click", locator: { role: "button", name: "Go" } }).capture,
        port: 0,
        announce: (message) => announced.push(message),
      });
      await resumeThrough(announced);
      await handover;
    }

    const records = await recordsOf(evidence);
    // Two escalations, two pairs of handovers, two of the person's Actions —
    // not four transitions for the second pause because the first one's
    // listener was still attached.
    expect(records.map((record) => record["kind"])).toEqual([
      "run-started",
      "intervention-request",
      "control",
      "action",
      "control",
      "intervention-request",
      "control",
      "action",
      "control",
    ]);
  });
});

describe("a handover that could not be set up", () => {
  it("gives control back rather than leaving the agent refused forever", async () => {
    const control = new SessionControl();
    const evidence = await startRun();

    await expect(
      handOverToHuman({
        control,
        evidence,
        request: REQUEST,
        // The browser went away between the refusal and the handover, or the
        // listeners could not be installed.
        capture: async () => {
          throw new Error("the page is gone");
        },
        port: 0,
      }),
    ).rejects.toThrow("the page is gone");

    // A Controller stuck on `human` refuses every later Action with no way left
    // to un-refuse it: the endpoint that would have returned control never
    // opened.
    expect(control.controller).toBe("agent");
  });
});
