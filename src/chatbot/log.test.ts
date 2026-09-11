import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ChatResult } from "./chatbot.js";
import { fileChatLogger } from "./log.js";

/**
 * The chatbot query log: one file per utterance, holding the chain the router
 * built with the real inputs each step was called with — the thing the redacted
 * evidence runs cannot answer. A password-shaped input is the one thing dropped.
 */
describe("the chatbot query log", () => {
  it("writes one file per query with the utterance, chain, and real inputs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cua-chatlog-"));
    const result: ChatResult = {
      steps: [
        {
          invocation: { ref: "member-balance@2", inputs: { memberNumber: "100234" } },
          outcome: { kind: "success", outputs: { name: "Lovelace, Ada" } },
        },
        {
          invocation: {
            ref: "funds-transfer@2",
            inputs: { memberNumber: "100234", fromShare: "100234-S0001-14 - Regular Shares ($68.00)", amount: "1.00" },
          },
          outcome: { kind: "success", outputs: { confirmationNumber: "CN480357" } },
        },
      ],
      answer: "Done. confirmationNumber: CN480357",
      ranOut: false,
    };

    fileChatLogger(dir)({ utterance: "transfer $1 from 100234 regular to money market", options: {}, result });

    const files = await readdir(dir);
    expect(files).toHaveLength(1);
    const logged = JSON.parse(await readFile(join(dir, files[0] as string), "utf8"));

    expect(logged.utterance).toBe("transfer $1 from 100234 regular to money market");
    expect(logged.answer).toBe("Done. confirmationNumber: CN480357");
    expect(logged.steps.map((s: { ref: string }) => s.ref)).toEqual(["member-balance@2", "funds-transfer@2"]);
    // The real inputs are kept — the whole point over the redacted evidence run.
    expect(logged.steps[1].inputs.fromShare).toBe("100234-S0001-14 - Regular Shares ($68.00)");
    expect(logged.steps[1].outcome.outputs.confirmationNumber).toBe("CN480357");
  });

  it("redacts an input keyed like a Secret", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cua-chatlog-"));
    const result: ChatResult = {
      steps: [{ invocation: { ref: "x", inputs: { operator: "teller1", password: "hunter2" } }, outcome: { kind: "success", outputs: {} } }],
      answer: "ok",
      ranOut: false,
    };

    fileChatLogger(dir)({ utterance: "sign on", options: {}, result });

    const files = await readdir(dir);
    const logged = JSON.parse(await readFile(join(dir, files[0] as string), "utf8"));
    expect(logged.steps[0].inputs.operator).toBe("teller1");
    expect(logged.steps[0].inputs.password).toBe("[REDACTED]");
  });
});
