import { describe, expect, it } from "vitest";
import { FakeSurface } from "../surface/fake-surface.js";
import { parabankScript } from "../surface/parabank/fake-script.js";
import type { Action, ActionResult, Snapshot, Surface } from "../surface/surface.js";
import { discover, type Decide, type Decision } from "./discover.js";

/**
 * The loop, driven by a scripted `decide` rather than by a model.
 *
 * The spec is explicit that the model's decisions are not tested — they are
 * non-deterministic, and asserting on them tests Anthropic. What is testable,
 * and what actually has to hold, is everything around them: that a decision
 * reaches the Surface, that what came back reaches the model, and that the loop
 * stops for each of the four declared reasons rather than running forever.
 * A real model on a real ParaBank is not a test here: it is non-deterministic
 * and it costs a call per run. The committed Discovery Run under
 * `evidence/runs/` is what says that path works.
 */
const OVERVIEW = "http://localhost:8080/parabank/overview.htm";

/** A `decide` that plays a fixed list of turns and then calls no tool. */
function scripted(...turns: Decision[][]): Decide {
  let turn = 0;
  return async () => turns[turn++] ?? [];
}

function act(action: Action, reason = "because"): Decision {
  return { kind: "act", reason, action };
}

const options = { entryUrl: OVERVIEW, maxSteps: 10, timeoutMs: 60_000 };

function parabank(): Surface {
  return new FakeSurface(parabankScript());
}

/** A Surface that answers everything the same way, for the paths a script cannot reach. */
function alwaysAnswers(result: ActionResult): Surface {
  return {
    snapshot: async (): Promise<Snapshot> => ({ url: OVERVIEW, tree: "- document", nodes: [] }),
    // The entry navigate is the loop's own Step and has to land, or the run
    // stops before the model has said anything.
    perform: async (action) => (action.kind === "navigate" ? { kind: "ok" } : result),
    screenshot: async () => Buffer.from("a screen"),
  };
}

describe("a discovery run", () => {
  it("ends when the model says the goal is met, and says what it took", async () => {
    const result = await discover(
      parabank(),
      scripted(
        [act({ kind: "waitFor", locator: { role: "row", name: "$", ordinal: 0 } }, "Wait for rows.")],
        [{ kind: "done", reason: "Both values are on screen.", summary: "SAVINGS, $1231.10" }],
      ),
      options,
    );

    expect(result).toMatchObject({ kind: "goal-reached", summary: "SAVINGS, $1231.10" });
    // The entry Step the loop took, then the one the model asked for.
    expect(result.steps).toHaveLength(2);
    expect(result.steps.map((step) => step.action.kind)).toEqual(["navigate", "waitFor"]);
  });

  it("starts by going to the entry point, so the Steps say how the run got there", async () => {
    // #10 filters this list into a Recording. One that does not include reaching
    // its own first screen would replay against whatever page was already open.
    const result = await discover(parabank(), scripted([]), options);

    expect(result.steps[0]).toMatchObject({
      action: { kind: "navigate", url: OVERVIEW },
      result: { kind: "ok" },
    });
  });

  it("keeps which declared value a read was for, which is all the recorder has to go on", async () => {
    const result = await discover(
      parabank(),
      scripted([
        {
          kind: "act",
          reason: "The balance is the second cell of its labelled row.",
          action: {
            kind: "read",
            locator: { role: "cell", ordinal: 1, within: { role: "row", name: "Balance:" } },
          },
          bind: "balance",
        },
      ]),
      options,
    );

    expect(result.steps.at(-1)).toMatchObject({ bind: "balance" });
  });

  it("dispatches each decision to the Surface in the order it was decided", async () => {
    const performed: Action[] = [];
    const surface = parabank();
    const watched: Surface = {
      snapshot: () => surface.snapshot(),
      screenshot: () => surface.screenshot(),
      perform: async (action) => {
        performed.push(action);
        return await surface.perform(action);
      },
    };

    await discover(
      watched,
      scripted([
        act({ kind: "waitFor", locator: { role: "row", name: "$", ordinal: 0 } }),
        act({ kind: "click", locator: { role: "link", name: "12345", exact: true } }),
      ]),
      options,
    );

    expect(performed.map((action) => action.kind)).toEqual(["navigate", "waitFor", "click"]);
  });

  it("hands the model what each Action produced, on the turn after it", async () => {
    const seen: string[][] = [];
    const decide: Decide = async (_observation, reports) => {
      seen.push(reports.map((report) => report.text));
      return seen.length === 1
        ? [act({ kind: "waitFor", locator: { role: "row", name: "$", ordinal: 0 } })]
        : [{ kind: "done", reason: "done", summary: "done" }];
    };

    await discover(parabank(), decide, options);

    // Nothing on the first turn: the entry Step was the loop's, not a call the
    // model made and is owed an answer for.
    expect(seen).toEqual([[], ["ok"]]);
  });

  it("stops at the step limit rather than running on", async () => {
    const forever = scripted(...Array.from({ length: 20 }, () => [act({ kind: "navigate", url: OVERVIEW })]));

    const result = await discover(parabank(), forever, { ...options, maxSteps: 3 });

    expect(result).toMatchObject({ kind: "stopped", because: "max-steps" });
    // The entry Step counts: it is an Action this run took.
    expect(result.steps).toHaveLength(3);
  });

  it("stops when it runs out of time", async () => {
    let clock = 0;
    const forever = scripted(...Array.from({ length: 20 }, () => [act({ kind: "navigate", url: OVERVIEW })]));

    const result = await discover(parabank(), forever, {
      entryUrl: OVERVIEW,
      maxSteps: 100,
      timeoutMs: 500,
      // Each reading moves a second, so the run is out of time on the second turn.
      now: () => (clock += 1_000),
    });

    expect(result).toMatchObject({ kind: "stopped", because: "timeout" });
  });

  it("stops at a dead end when the model calls no tool at all", async () => {
    // The model has nothing left to try and has not called `done`. There is no
    // action to take and no goal reached, so the run ends rather than asking
    // again and getting the same silence.
    const result = await discover(parabank(), scripted([]), options);

    expect(result).toMatchObject({ kind: "stopped", because: "dead-end" });
  });

  it("raises an Intervention Request when the gate refuses, instead of carrying on", async () => {
    // ADR 0007: during a Discovery Run a risky Step raises an Intervention
    // Request rather than acting. The gate has already refused by the time the
    // loop sees this; what the loop must not do is treat it as one more miss to
    // work around.
    const refusing = alwaysAnswers({
      kind: "refused",
      reason: `"/transfer.htm" can change data, and this run has no mandate to.`,
    });

    const result = await discover(
      refusing,
      scripted([act({ kind: "click", locator: { role: "link", name: "Transfer Funds" } }, "Try it.")]),
      options,
    );

    expect(result).toMatchObject({
      kind: "intervention-request",
      reason: `"/transfer.htm" can change data, and this run has no mandate to.`,
    });
    // The entry Step, then the one that was refused.
    expect(result.steps).toHaveLength(2);
  });

  it("tells the model a call it could not parse, and lets the run continue", async () => {
    const seen: string[][] = [];
    const decide: Decide = async (_observation, reports) => {
      seen.push(reports.map((report) => report.text));
      if (seen.length === 1) return [{ kind: "unusable", complaint: "locator.role: bad role" }];
      return [{ kind: "done", reason: "recovered", summary: "recovered" }];
    };

    const result = await discover(parabank(), decide, options);

    expect(seen[1]).toEqual(["locator.role: bad role"]);
    expect(result).toMatchObject({ kind: "goal-reached" });
    // A call that never became an Action is not a Step that was taken, so the
    // entry Step is still the only one.
    expect(result.steps.map((step) => step.action.kind)).toEqual(["navigate"]);
  });

  it("shows each Step as it happens, so a long run is not a silent terminal", async () => {
    const shown: string[] = [];

    await discover(
      parabank(),
      scripted(
        [act({ kind: "waitFor", locator: { role: "row", name: "$", ordinal: 0 } }, "Wait for rows.")],
        [{ kind: "done", reason: "done", summary: "done" }],
      ),
      { ...options, onStep: (step) => shown.push(step.reason) },
    );

    expect(shown).toEqual([`The run's entry point.`, "Wait for rows."]);
  });

  it("observes the screen before every decision", async () => {
    const urls: string[] = [];
    const decide: Decide = async (observation) => {
      urls.push(observation.url);
      return urls.length === 1
        ? [act({ kind: "click", locator: { role: "link", name: "12345", exact: true } })]
        : [{ kind: "done", reason: "done", summary: "done" }];
    };

    await discover(parabank(), decide, options);

    // On the overview for the first decision — the entry Step already ran — and
    // on the detail screen for the second, which is the loop having re-observed
    // rather than reusing what it had.
    expect(urls[0]).toBe(OVERVIEW);
    expect(urls[1]).not.toBe(OVERVIEW);
  });
});
