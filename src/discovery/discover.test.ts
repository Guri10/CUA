import { describe, expect, it } from "vitest";
import { FakeSurface } from "../surface/fake-surface.js";
import { parabankScript } from "../surface/parabank/fake-script.js";
import type { Action, ActionResult, Snapshot, Surface } from "../surface/surface.js";
import { discover, type Decide, type Decision, type Escalate } from "./discover.js";
import type { InterventionRequest } from "../escalation/intervention-request.js";

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

/**
 * The escalation, from the loop's side. What a handover actually involves is
 * `handover.test.ts`; what this file holds is the decision the loop makes when
 * the gate refuses and somebody is watching — and the two ways the run can go
 * on from there.
 */
describe("a discovery run with a person watching", () => {
  const REFUSAL = `"/openaccount.htm" can change data, and this run has no mandate to.`;

  /** A Surface that refuses the one risky click and behaves for everything else. */
  function refusesOpeningAnAccount(): Surface {
    const inner = parabank();
    return {
      snapshot: () => inner.snapshot(),
      screenshot: () => inner.screenshot(),
      perform: async (action) => {
        if (action.kind === "click" && action.locator.name === "Open New Account") {
          return { kind: "refused", reason: REFUSAL };
        }
        return await inner.perform(action);
      },
    };
  }

  const risky = act(
    { kind: "click", locator: { role: "link", name: "Open New Account" } },
    "Open the account.",
  );

  /** The person, played by the test: they do these, then hand the session back. */
  function operatorWho(...actions: Action[]): { escalate: Escalate; asked: InterventionRequest[] } {
    const asked: InterventionRequest[] = [];
    return {
      asked,
      escalate: async (request) => {
        asked.push(request);
        return actions;
      },
    };
  }

  it("hands the session over instead of ending, and carries on where the person left it", async () => {
    const operator = operatorWho({
      kind: "click",
      locator: { role: "button", name: "Open New Account", exact: true },
    });

    const result = await discover(
      refusesOpeningAnAccount(),
      scripted([risky], [{ kind: "done", reason: "The account is open.", summary: "opened" }]),
      { ...options, escalate: operator.escalate, attempting: "open-account@1" },
    );

    expect(result).toMatchObject({ kind: "goal-reached", summary: "opened" });
    // The entry Step, the refused one, and the person's — in the order they
    // happened, in one list, because that is the order the flow went in.
    expect(result.steps.map((step) => [step.by, step.action.kind])).toEqual([
      ["agent", "navigate"],
      ["agent", "click"],
      ["human", "click"],
    ]);
  });

  it("gives the operator the four things an Intervention Request carries", async () => {
    const operator = operatorWho();

    await discover(
      refusesOpeningAnAccount(),
      scripted([risky], [{ kind: "done", reason: "done", summary: "done" }]),
      { ...options, escalate: operator.escalate, attempting: "open-account@1" },
    );

    expect(operator.asked).toHaveLength(1);
    expect(operator.asked[0]).toMatchObject({
      capability: "open-account@1",
      // No Recording exists yet, so the Step is the Action that was refused.
      step: `click on link "Open New Account"`,
      reason: REFUSAL,
    });
    // The observed state, read off the live Surface rather than described from
    // memory: it is what the operator has in front of them.
    expect(operator.asked[0]?.observed.url).toContain("parabank");
    expect(operator.asked[0]?.observed.tree).toContain("-");
  });

  it("re-observes after a handover rather than draining the rest of the batch", async () => {
    const performed: Action[] = [];
    const inner = refusesOpeningAnAccount();
    const watched: Surface = {
      snapshot: () => inner.snapshot(),
      screenshot: () => inner.screenshot(),
      perform: async (action) => {
        performed.push(action);
        return await inner.perform(action);
      },
    };
    // The refused Action and a second one, decided together against the screen
    // as it was before the person touched it.
    const staleTail = act({ kind: "click", locator: { role: "button", name: "STALE-TAIL", exact: true } });

    const result = await discover(
      watched,
      scripted([risky, staleTail], [{ kind: "done", reason: "d", summary: "d" }]),
      {
        ...options,
        escalate: operatorWho({ kind: "click", locator: { role: "button", name: "Open New Account", exact: true } })
          .escalate,
        attempting: "open-account@1",
      },
    );

    expect(result).toMatchObject({ kind: "goal-reached" });
    // The tail was decided against a screen the person then changed, so the loop
    // must have broken the batch and re-decided instead of dispatching it.
    expect(performed.some((action) => action.kind === "click" && action.locator.name === "STALE-TAIL")).toBe(false);
  });

  it("masks the session token in observed.url at the source", async () => {
    const withToken: Surface = {
      snapshot: async () => ({
        url: "http://localhost:8080/parabank/overview.htm;jsessionid=SECRET123",
        tree: "- document",
        nodes: [],
      }),
      screenshot: async () => Buffer.from("a screen"),
      perform: async (action) =>
        action.kind === "navigate" ? { kind: "ok" } : { kind: "refused", reason: REFUSAL },
    };
    const operator = operatorWho();

    await discover(withToken, scripted([risky]), {
      ...options,
      escalate: operator.escalate,
      attempting: "open-account@1",
    });

    // The contract `ObservedState.url` documents — token masked — held at the
    // source, so the value never travels unmasked (handover keeps its own mask
    // as defence in depth on a Secret).
    expect(operator.asked[0]?.observed.url).not.toContain("SECRET123");
    expect(operator.asked[0]?.observed.url).toContain("jsessionid=[REDACTED]");
  });

  it("does not retry the Action it was refused", async () => {
    const attempted: Action[] = [];
    const inner = refusesOpeningAnAccount();
    const watched: Surface = {
      snapshot: () => inner.snapshot(),
      screenshot: () => inner.screenshot(),
      perform: async (action) => {
        attempted.push(action);
        return await inner.perform(action);
      },
    };

    await discover(watched, scripted([risky], [{ kind: "done", reason: "d", summary: "d" }]), {
      ...options,
      escalate: operatorWho().escalate,
    });

    // The gate that refused it once refuses it again, and the thing needing a
    // person has now been done by one. Retrying is how a resumed run undoes the
    // handover it just had.
    expect(attempted.filter((action) => action.kind === "click")).toHaveLength(1);
  });

  it("tells the model the screen moved on without it", async () => {
    const seen: string[][] = [];
    let turn = 0;
    const decide: Decide = async (_observation, reports) => {
      seen.push(reports.map((report) => report.text));
      turn += 1;
      if (turn === 1) return [risky];
      return [{ kind: "done", reason: "d", summary: "d" }];
    };

    await discover(refusesOpeningAnAccount(), decide, {
      ...options,
      escalate: operatorWho({ kind: "click", locator: { role: "button", name: "Open" } }).escalate,
    });

    // Not marked an error: nothing went wrong, and a model told "error" looks
    // for something to fix rather than for where it now is.
    expect(seen[1]?.[0]).toContain("A human operator took the session");
    expect(seen[1]?.[0]).toContain("1 action(s)");
  });

  it("still ends with the Intervention Request when nobody takes it", async () => {
    const result = await discover(
      refusesOpeningAnAccount(),
      scripted([risky]),
      // An operator who was offered the session and did not take it — the same
      // ending an unattended run has, because it is the same situation.
      { ...options, escalate: async () => undefined },
    );

    expect(result).toMatchObject({ kind: "intervention-request", reason: REFUSAL });
  });

  it("does not spend the run's clock on the time a person held the session", async () => {
    let clock = 0;
    const result = await discover(
      refusesOpeningAnAccount(),
      scripted([risky], [{ kind: "done", reason: "d", summary: "d" }]),
      {
        ...options,
        timeoutMs: 1_000,
        now: () => clock,
        escalate: async () => {
          // The operator read the screen, worked out what was wrong, and fixed
          // it. A timeout is a bound on how long the automation may take.
          clock += 600_000;
          return [];
        },
      },
    );

    expect(result).toMatchObject({ kind: "goal-reached" });
  });
});
