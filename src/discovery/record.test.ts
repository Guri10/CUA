import { describe, expect, it } from "vitest";
import { isBaseRecording, type Capability } from "../capability/schema.js";
import type { Action } from "../surface/surface.js";
import type { TakenStep } from "./discover.js";
import { recordCapability, type RecordingPlan, type RecordingResult } from "./record.js";

/**
 * The recorder, as a pure function over a fixed list of Actions.
 *
 * This is where the spec draws the tested boundary on the discovery path: the
 * model's decisions are non-deterministic and asserting on them tests
 * Anthropic, but what happens to a given list of Actions afterwards is fixed.
 * So the list below is not invented — it is the run committed under
 * `evidence/runs/…-discover/`, the Actions a real `claude-opus-5` took against
 * a real ParaBank, with the dead ends and the retries this file exists to
 * remove written back in.
 */
const BASE_URL = "http://localhost:8080/parabank";

function plan(overrides: Partial<RecordingPlan> = {}): RecordingPlan {
  return {
    id: "account-lookup",
    version: 2,
    surface: "parabank",
    summary: "Look up one account's type and balance by account number.",
    effects: "read-only",
    baseUrl: BASE_URL,
    inputs: { accountId: "13344" },
    outputs: ["accountType", "balance"],
    ...overrides,
  };
}

function took(action: Action, extra: Partial<TakenStep> = {}): TakenStep {
  return { action, reason: "because", result: { kind: "ok" }, ...extra };
}

const accountTypeCell = {
  role: "cell",
  ordinal: 1,
  within: { role: "row", name: "Account Type:" },
} as const;

const balanceCell = {
  role: "cell",
  ordinal: 1,
  within: { role: "row", name: "Balance:" },
} as const;

/** The run as it happened: entry, wait, click, and the two reads. */
function successfulRun(): TakenStep[] {
  return [
    took({ kind: "navigate", url: `${BASE_URL}/overview.htm` }),
    took({ kind: "waitFor", locator: { role: "link", name: "13344" } }),
    took({ kind: "click", locator: { role: "link", name: "13344", exact: true } }),
    took(
      { kind: "read", locator: accountTypeCell },
      { bind: "accountType", result: { kind: "ok", value: "CHECKING" } },
    ),
    took(
      { kind: "read", locator: balanceCell },
      { bind: "balance", result: { kind: "ok", value: "$1,231.10" } },
    ),
  ];
}

function recorded(result: RecordingResult): Capability {
  if (result.kind === "unrecordable") {
    throw new Error(`Expected a Capability, got: ${result.reasons.join("; ")}`);
  }
  return result.capability;
}

function stepsOf(capability: Capability) {
  const base = capability.recordings.find(isBaseRecording);
  return base!.steps;
}

function reasonsOf(result: RecordingResult): string[] {
  return result.kind === "unrecordable" ? [...result.reasons] : [];
}

describe("recording a Discovery Run", () => {
  it("turns a fixed list of Actions into the Recording it should", () => {
    const capability = recorded(recordCapability(plan(), successfulRun()));

    expect(stepsOf(capability)).toEqual([
      {
        id: "navigate-overview-htm",
        // A path, not the URL the run actually went to. The origin belongs to
        // the Surface profile; a Recording carrying one runs against exactly
        // one installation.
        action: { kind: "navigate", url: { kind: "literal", value: "/overview.htm" } },
      },
      {
        id: "wait-for-link",
        action: {
          kind: "waitFor",
          locator: { role: "link", name: { kind: "input", input: "accountId" } },
        },
      },
      {
        id: "click-link",
        action: {
          kind: "click",
          locator: { role: "link", name: { kind: "input", input: "accountId" }, exact: true },
        },
      },
      {
        id: "read-account-type",
        action: {
          kind: "read",
          bind: "accountType",
          locator: {
            role: "cell",
            ordinal: 1,
            within: { role: "row", name: { kind: "literal", value: "Account Type:" } },
          },
        },
      },
      {
        id: "read-balance",
        action: {
          kind: "read",
          bind: "balance",
          locator: {
            role: "cell",
            ordinal: 1,
            within: { role: "row", name: { kind: "literal", value: "Balance:" } },
          },
        },
      },
    ]);
  });

  it("leaves out the Actions that did not work", () => {
    // The shape of a real run: the model addresses a control that is not there,
    // is told so, and tries something else. The Recording is the flow that
    // worked, not the search that found it.
    const run = [
      ...successfulRun().slice(0, 1),
      took(
        { kind: "click", locator: { role: "link", name: "Accounts" } },
        { result: { kind: "not-found", locator: { role: "link", name: "Accounts" } } },
      ),
      took(
        { kind: "click", locator: { role: "link", name: "13344" } },
        { result: { kind: "ambiguous", locator: { role: "link", name: "13344" }, matches: 2 } },
      ),
      ...successfulRun().slice(1),
    ];

    const capability = recorded(recordCapability(plan(), run));

    expect(stepsOf(capability).map((step) => step.id)).toEqual([
      "navigate-overview-htm",
      "wait-for-link",
      "click-link",
      "read-account-type",
      "read-balance",
    ]);
  });

  it("keeps only the last of a value typed twice into the same control", () => {
    // A retry among the Actions that worked: the model typed one thing, thought
    // better of it, and typed another. Replaying both would type the first into
    // a box that is about to be overwritten.
    const search = { role: "textbox", name: "Search" } as const;
    const run = [
      took({ kind: "navigate", url: `${BASE_URL}/overview.htm` }),
      took({ kind: "fill", locator: search, value: "1334" }),
      took({ kind: "fill", locator: search, value: "13344" }),
      took({ kind: "click", locator: { role: "button", name: "Find" } }),
      took(
        { kind: "read", locator: balanceCell },
        { bind: "balance", result: { kind: "ok", value: "$1,231.10" } },
      ),
    ];

    const steps = stepsOf(recorded(recordCapability(plan({ outputs: ["balance"] }), run)));

    expect(steps.filter((step) => step.action.kind === "fill")).toEqual([
      {
        id: "fill-textbox-search",
        action: {
          kind: "fill",
          locator: { role: "textbox", name: { kind: "literal", value: "Search" } },
          value: { kind: "input", input: "accountId" },
        },
      },
    ]);
  });

  it("keeps the same wait on either side of a click, because those are two screens", () => {
    // The collapse is bounded by the Actions that move the screen. Two waits for
    // a heading that appears on both screens are two checkpoints, and dropping
    // the first would leave the click unguarded.
    const heading = { role: "heading", name: "ParaBank" } as const;
    const run = [
      took({ kind: "navigate", url: `${BASE_URL}/overview.htm` }),
      took({ kind: "waitFor", locator: heading }),
      took({ kind: "click", locator: { role: "link", name: "13344", exact: true } }),
      took({ kind: "waitFor", locator: heading }),
      took(
        { kind: "read", locator: balanceCell },
        { bind: "balance", result: { kind: "ok", value: "$1,231.10" } },
      ),
    ];

    const steps = stepsOf(recorded(recordCapability(plan({ outputs: ["balance"] }), run)));

    // Two of them, and told apart by a suffix rather than by position.
    expect(steps.filter((step) => step.action.kind === "waitFor").map((step) => step.id)).toEqual([
      "wait-for-heading-para-bank",
      "wait-for-heading-para-bank-2",
    ]);
  });

  it("drops a read the model took for itself, and keeps the last read of a declared value", () => {
    const run = [
      ...successfulRun().slice(0, 3),
      // Looking around: it binds nothing, so at replay it would address a
      // control, take its text, and throw it away.
      took({ kind: "read", locator: { role: "heading", name: "Account Details" } }),
      took(
        { kind: "read", locator: accountTypeCell },
        { bind: "accountType", result: { kind: "ok", value: "CHECKING" } },
      ),
      // Read once before the value arrived, then again. The second is the one
      // the run reported, so it is the one recorded.
      took(
        { kind: "read", locator: { role: "cell", ordinal: 0, within: { role: "row", name: "Balance:" } } },
        { bind: "balance", result: { kind: "ok", value: "Balance:" } },
      ),
      took(
        { kind: "read", locator: balanceCell },
        { bind: "balance", result: { kind: "ok", value: "$1,231.10" } },
      ),
    ];

    const steps = stepsOf(recorded(recordCapability(plan(), run)));

    expect(steps.filter((step) => step.action.kind === "read")).toEqual([
      expect.objectContaining({ id: "read-account-type" }),
      expect.objectContaining({
        id: "read-balance",
        action: expect.objectContaining({ locator: expect.objectContaining({ ordinal: 1 }) }),
      }),
    ]);
  });

  it("declares the Contract it was given, and the Terminal State the run reached", () => {
    const capability = recorded(recordCapability(plan(), successfulRun()));

    expect(capability.contract.inputs.properties).toEqual({ accountId: { type: "string" } });
    expect(capability.contract.outputs.properties).toEqual({
      accountType: { type: "string" },
      balance: { type: "string" },
    });
    expect(capability.contract.effects).toBe("read-only");
    // Success is the controls the declared values were read from, all present:
    // if they are there the outputs can be extracted, and if they are not the
    // run has not arrived.
    expect(capability.contract.terminalStates).toEqual([
      {
        kind: "success",
        when: {
          kind: "all",
          of: [
            { kind: "present", locator: expect.objectContaining({ ordinal: 1 }) },
            { kind: "present", locator: expect.objectContaining({ ordinal: 1 }) },
          ],
        },
      },
    ]);
  });

  it("falls back to the last thing waited for when the Capability returns nothing", () => {
    // #12's shape: a flow that does something rather than answering something.
    // The checkpoint the model chose as "I have arrived" is the only claim the
    // run supports.
    const run = [
      took({ kind: "navigate", url: `${BASE_URL}/openaccount.htm` }),
      took({ kind: "waitFor", locator: { role: "heading", name: "Open New Account" } }),
      took({ kind: "click", locator: { role: "button", name: "Open New Account" } }),
      took({ kind: "waitFor", locator: { role: "heading", name: "Account Opened!" } }),
    ];

    const capability = recorded(
      recordCapability(plan({ inputs: {}, outputs: [] }), run),
    );

    expect(capability.contract.terminalStates).toEqual([
      {
        kind: "success",
        when: {
          kind: "all",
          of: [
            {
              kind: "present",
              locator: {
                role: "heading",
                name: { kind: "literal", value: "Account Opened!" },
              },
            },
          ],
        },
      },
    ]);
  });

  it("declares no Business Outcome, because a successful run never saw one", () => {
    // ADR 0004's cost, stated where it lands. A run that reached the balance
    // has no evidence of what "no such account" looks like, and guessing is the
    // one thing the ADR rules out.
    const capability = recorded(recordCapability(plan(), successfulRun()));

    expect(capability.contract.terminalStates.map((state) => state.kind)).toEqual(["success"]);
  });

  it("never approves what it wrote", () => {
    // ADR 0007 makes approval load-bearing for a mutating Capability. A file
    // written unattended that approved itself would make the check decorative.
    expect(recorded(recordCapability(plan(), successfulRun())).approval).toBe("draft");
  });

  it("gives every Step an id derived from what it does, not from where it sits", () => {
    // Stable, because a variant patch and a failure report both name a Step by
    // id. Inserting a Step above one must not rename it.
    const withExtraWait = [
      ...successfulRun().slice(0, 1),
      took({ kind: "waitFor", locator: { role: "heading", name: "Accounts Overview" } }),
      ...successfulRun().slice(1),
    ];

    const before = stepsOf(recorded(recordCapability(plan(), successfulRun())));
    const after = stepsOf(recorded(recordCapability(plan(), withExtraWait)));

    expect(after.map((step) => step.id)).toEqual([
      "navigate-overview-htm",
      "wait-for-heading-accounts-overview",
      ...before.slice(1).map((step) => step.id),
    ]);
  });

  it("refuses a run that never used an input, rather than recording one that ignores it", () => {
    // The quietest way this could be wrong: the Contract asks for an account
    // number, no Step refers to it, and every replay returns the balance of
    // whichever account the run was recorded against. The schema does not catch
    // it — a Recording using fewer inputs than the Contract declares is
    // well-formed — so the recorder does.
    const byPosition = [
      took({ kind: "navigate", url: `${BASE_URL}/overview.htm` }),
      took({ kind: "click", locator: { role: "link", ordinal: 0 } }),
      took(
        { kind: "read", locator: balanceCell },
        { bind: "balance", result: { kind: "ok", value: "$1,231.10" } },
      ),
    ];

    const result = recordCapability(plan({ outputs: ["balance"] }), byPosition);

    expect(result.kind).toBe("unrecordable");
    expect(reasonsOf(result).join("\n")).toMatch(/No Step used input "accountId"/);
  });

  it("refuses a run that never read a value the Contract promises", () => {
    const result = recordCapability(plan(), successfulRun().slice(0, 4));

    expect(reasonsOf(result).join("\n")).toMatch(/never read a value for "balance"/);
  });

  it("names every reason at once, so the next run is not the one that finds the next problem", () => {
    const result = recordCapability(
      plan({ inputs: { accountId: "13344", customerId: "54321" }, outputs: ["accountType", "iban"] }),
      successfulRun(),
    );

    expect(reasonsOf(result)).toHaveLength(2);
    expect(reasonsOf(result).join("\n")).toMatch(/customerId/);
    expect(reasonsOf(result).join("\n")).toMatch(/"iban"/);
  });

  it("refuses two inputs given the same value, which it could not tell apart", () => {
    const result = recordCapability(
      plan({ inputs: { accountId: "13344", payeeId: "13344" }, outputs: ["balance"] }),
      successfulRun(),
    );

    expect(reasonsOf(result).join("\n")).toMatch(/same value/);
  });

  it("refuses an address the run was not pointed at, rather than storing an origin", () => {
    const wandered = [
      took({ kind: "navigate", url: "http://elsewhere.example/overview.htm" }),
      ...successfulRun().slice(1),
    ];

    const result = recordCapability(plan(), wandered);

    expect(reasonsOf(result).join("\n")).toMatch(/not under http:\/\/localhost:8080\/parabank/);
  });

  it("parameterises only a whole value, never part of one", () => {
    // Substring replacement is the rule that reads as more helpful and corrupts
    // a Recording quietly: an account id of "1" would rewrite the "1" in
    // "$1,231.10" and in every path.
    const run = [
      took({ kind: "navigate", url: `${BASE_URL}/overview.htm` }),
      took({ kind: "click", locator: { role: "link", name: "1", exact: true } }),
      took(
        { kind: "read", locator: balanceCell },
        { bind: "balance", result: { kind: "ok", value: "$1,231.10" } },
      ),
    ];

    const steps = stepsOf(
      recorded(recordCapability(plan({ inputs: { accountId: "1" }, outputs: ["balance"] }), run)),
    );

    expect(steps[0]?.action).toEqual({
      kind: "navigate",
      url: { kind: "literal", value: "/overview.htm" },
    });
    expect(steps[1]?.action).toMatchObject({
      locator: { name: { kind: "input", input: "accountId" } },
    });
  });
});
