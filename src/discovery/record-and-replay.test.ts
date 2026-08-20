import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadCapabilityRef, saveCapability } from "../capability/storage.js";
import { replayCapability } from "../replay/replay.js";
import { FakeSurface } from "../surface/fake-surface.js";
import { parabankScript, PARABANK_CAPTURED_BASE_URL } from "../surface/parabank/fake-script.js";
import type { Action } from "../surface/surface.js";
import { discover, type Decide, type Decision } from "./discover.js";
import { recordCapability, type RecordingPlan } from "./record.js";

/**
 * The loop closed: a Discovery Run, saved to disk, loaded back, and replayed
 * with no model anywhere in the second half.
 *
 * The point of the whole system in one test. Everything on either side of the
 * recorder is already covered — `discover.test.ts` holds the loop,
 * `replay.test.ts` holds the executor — and what neither of them can say is
 * that what one produced is something the other can actually run. A recorder
 * that wrote a plausible file nothing could replay would pass both.
 *
 * No browser and no model. The decisions are scripted, exactly as they are in
 * `discover.test.ts` and for the same reason: the model's choices are not what
 * is being tested here. The screens are the accessibility trees real ParaBank
 * served, so the Locators being recorded address controls that existed.
 */
const ACCOUNT = "12345";

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

function act(action: Action, bind?: string): Decision {
  return {
    kind: "act",
    reason: "because",
    action,
    ...(bind === undefined ? {} : { bind }),
  };
}

/** A `decide` that plays a fixed list of turns and then calls no tool. */
function scripted(...turns: Decision[][]): Decide {
  let turn = 0;
  return async () => turns[turn++] ?? [];
}

/**
 * The lookup as a run would find it: wait for the account's link, open it, take
 * the two values, stop. The failed attempt in the middle is not decoration —
 * it is what a real run looks like, and the Recording must not contain it.
 */
function lookupRun(): Decide {
  return scripted(
    [act({ kind: "click", locator: { role: "link", name: "Account Details" } })],
    [act({ kind: "waitFor", locator: { role: "link", name: ACCOUNT, exact: true } })],
    [act({ kind: "click", locator: { role: "link", name: ACCOUNT, exact: true } })],
    [act({ kind: "read", locator: accountTypeCell }, "accountType")],
    [act({ kind: "read", locator: balanceCell }, "balance")],
    [{ kind: "done", reason: "Both values are on screen.", summary: "CHECKING, -$2300.00" }],
  );
}

describe("a Discovery Run, recorded and then replayed", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "cua-capabilities-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("saves a valid Capability, which replays and returns the same values", async () => {
    const run = await discover(new FakeSurface(parabankScript()), lookupRun(), {
      entryUrl: `${PARABANK_CAPTURED_BASE_URL}/overview.htm`,
      maxSteps: 10,
      timeoutMs: 60_000,
    });
    expect(run).toMatchObject({ kind: "goal-reached" });

    const plan: RecordingPlan = {
      id: "account-lookup-recorded",
      version: 1,
      surface: "parabank",
      summary: "Look up one account's type and balance by account number.",
      effects: "read-only",
      baseUrl: PARABANK_CAPTURED_BASE_URL,
      inputs: { accountId: ACCOUNT },
      outputs: ["accountType", "balance"],
    };

    const recorded = recordCapability(plan, run.steps);
    if (recorded.kind === "unrecordable") {
      throw new Error(`The run could not be recorded: ${recorded.reasons.join("; ")}`);
    }

    // Through disk, not held in memory. `saveCapability` validates on the way
    // out and `loadCapabilityRef` again on the way in, so a Recording that only
    // looked right in the shape the recorder returned would not survive this.
    const path = await saveCapability(root, recorded.capability);
    expect(path).toBe(join(root, "account-lookup-recorded", "1.json"));

    const loaded = await loadCapabilityRef(root, "account-lookup-recorded");
    const result = await replayCapability(
      new FakeSurface(parabankScript()),
      loaded,
      { accountId: ACCOUNT },
      { baseUrl: PARABANK_CAPTURED_BASE_URL },
    );

    expect(result).toEqual({
      kind: "success",
      outputs: { accountType: "CHECKING", balance: "-$2300.00" },
    });
  });

  it("records a flow that works for an account other than the one it was recorded against", async () => {
    // The whole reason a Step stores an Expression. If the recorder had left
    // "12345" in the Locator, this run would open the recorded account and
    // report its balance as the answer to a question about another one.
    const run = await discover(new FakeSurface(parabankScript()), lookupRun(), {
      entryUrl: `${PARABANK_CAPTURED_BASE_URL}/overview.htm`,
      maxSteps: 10,
      timeoutMs: 60_000,
    });

    const recorded = recordCapability(
      {
        id: "account-lookup-recorded",
        version: 1,
        surface: "parabank",
        summary: "Look up one account's type and balance by account number.",
        effects: "read-only",
        baseUrl: PARABANK_CAPTURED_BASE_URL,
        inputs: { accountId: ACCOUNT },
        outputs: ["accountType", "balance"],
      },
      run.steps,
    );
    if (recorded.kind === "unrecordable") {
      throw new Error(`The run could not be recorded: ${recorded.reasons.join("; ")}`);
    }

    const result = await replayCapability(
      new FakeSurface(parabankScript()),
      recorded.capability,
      { accountId: "99999" },
      { baseUrl: PARABANK_CAPTURED_BASE_URL },
    );

    // Not a Business Outcome: a run that succeeded never saw the not-found
    // screen, so the recorded Capability cannot name one and ADR 0004 says an
    // unrecognised ending is a Hard Failure rather than a guess. This is the
    // cost of an unattended recording, and it is what the operator is told to
    // go and fix before approving the file.
    // The wait, not the click: the run recorded a checkpoint before opening the
    // account, so that is where a Recording looking for a link that is not
    // there stops.
    expect(result).toMatchObject({ kind: "hard-failure", step: "wait-for-link" });
  });
});
