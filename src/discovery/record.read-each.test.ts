import { describe, expect, it } from "vitest";
import { isBaseRecording, type Capability } from "../capability/schema.js";
import type { Action } from "../surface/surface.js";
import type { TakenStep } from "./discover.js";
import { recordCapability, type RecordingPlan, type RecordingResult } from "./record.js";

/**
 * The recorder turning a run that read a table into a Capability whose output is
 * a list. It is the discovery half of `readEach`: a `read_each` the model called
 * becomes a `readEach` Step, its `bind` names a declared return value, and the
 * output that value carries is shaped from the columns the run read — an array
 * of records — rather than defaulted to text the way a scalar read's is.
 */
const BASE_URL = "https://web-sample.interface-hiring.com";

const shareRow = { role: "row", name: "$" } as const;
const shareColumns = {
  shareId: { role: "cell", ordinal: 0 },
  type: { role: "cell", ordinal: 1 },
  balance: { role: "cell", ordinal: 2 },
  status: { role: "cell", ordinal: 3 },
} as const;

function plan(overrides: Partial<RecordingPlan> = {}): RecordingPlan {
  return {
    id: "member-balance",
    version: 1,
    surface: "meridian",
    summary: "Read a member's shares.",
    effects: "read-only",
    baseUrl: BASE_URL,
    // No inputs here on purpose: this exercises the recorder's output shaping,
    // not input parameterisation, so the run reads a fixed record by position.
    inputs: {},
    outputs: ["shares"],
    ...overrides,
  };
}

function took(action: Action, extra: Partial<TakenStep> = {}): TakenStep {
  return { action, by: "agent", reason: "because", result: { kind: "ok" }, ...extra };
}

/** Entry, a wait for the first share row, then the tabular read of them all. */
function balanceRun(): TakenStep[] {
  return [
    took({ kind: "navigate", url: `${BASE_URL}/members/100234` }),
    took({ kind: "waitFor", locator: { ...shareRow, ordinal: 0 } }),
    took(
      { kind: "readEach", rows: shareRow, columns: shareColumns },
      {
        bind: "shares",
        result: {
          kind: "ok",
          records: [
            { shareId: "100234-S0001", type: "Regular Shares", balance: "$2,499.00", status: "HOLD [HOLD]" },
          ],
        },
      },
    ),
  ];
}

function recorded(result: RecordingResult): Capability {
  if (result.kind === "unrecordable") {
    throw new Error(`Expected a Capability, got: ${result.reasons.join("; ")}`);
  }
  return result.capability;
}

describe("recording a run that read a table with read_each", () => {
  it("shapes the bound output as an array of records, one field per column read", () => {
    const capability = recorded(recordCapability(plan(), balanceRun()));

    const shares = capability.contract.outputs.properties["shares"] as {
      type?: string;
      items?: { type?: string; properties?: Record<string, unknown> };
    };
    expect(shares.type).toBe("array");
    expect(shares.items?.type).toBe("object");
    expect(Object.keys(shares.items?.properties ?? {}).sort()).toEqual([
      "balance",
      "shareId",
      "status",
      "type",
    ]);
  });

  it("keeps the readEach as a Step that binds the declared output", () => {
    const capability = recorded(recordCapability(plan(), balanceRun()));
    const steps = capability.recordings.find(isBaseRecording)?.steps ?? [];

    const readEach = steps.find((step) => step.action.kind === "readEach");
    expect(readEach?.action).toMatchObject({ kind: "readEach", bind: "shares" });
  });

  it("still refuses when the declared list output was never read", () => {
    // The run navigates and waits but never performs the read_each, so nothing
    // binds `shares` — the same refusal a scalar output gets when it is declared
    // and never read.
    const withoutRead = balanceRun().slice(0, 2);

    const result = recordCapability(plan(), withoutRead);

    expect(result.kind).toBe("unrecordable");
  });
});
