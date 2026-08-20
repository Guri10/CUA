import { describe, expect, it } from "vitest";
import { decisionFor, reportOf } from "./decide.js";

/**
 * The boundary the spec draws: "the model's decisions" are not tested, because
 * they are non-deterministic and asserting on them tests Anthropic rather than
 * this system. What is tested is everything either side of them — given a tool
 * call, the Action it becomes is fully deterministic, and so is what the model
 * is told came back.
 */
describe("turning a tool call into an Action", () => {
  it("reads a click as the Action the Surface takes", () => {
    expect(
      decisionFor("click", {
        reason: "The account number is a link on the overview.",
        locator: { role: "link", name: "13344", exact: true },
      }),
    ).toEqual({
      kind: "act",
      reason: "The account number is a link on the overview.",
      action: { kind: "click", locator: { role: "link", name: "13344", exact: true } },
    });
  });

  it("carries a fill's value through", () => {
    expect(
      decisionFor("fill", {
        reason: "The first unnamed box is the username.",
        locator: { role: "textbox", ordinal: 0 },
        value: "john",
      }),
    ).toMatchObject({
      kind: "act",
      action: { kind: "fill", locator: { role: "textbox", ordinal: 0 }, value: "john" },
    });
  });

  it("renames wait_for to the verb the Surface seam uses", () => {
    expect(
      decisionFor("wait_for", {
        reason: "The rows arrive after the page does.",
        locator: { role: "row", name: "$", ordinal: 0 },
      }),
    ).toMatchObject({ kind: "act", action: { kind: "waitFor" } });
  });

  it("keeps a scoped Locator's enclosing control", () => {
    expect(
      decisionFor("read", {
        reason: "The balance is the second cell of its labelled row.",
        locator: { role: "cell", ordinal: 1, within: { role: "row", name: "Balance:" } },
      }),
    ).toMatchObject({
      action: { locator: { role: "cell", ordinal: 1, within: { role: "row", name: "Balance:" } } },
    });
  });

  it("carries which declared value a read is for, alongside the Action rather than in it", () => {
    // The recorder needs it and the Surface has no use for it, which is the
    // same place `reason` sits. Matching reads to declared values by the order
    // they happened would hand back a balance under the name of an account
    // type the first time a run read something twice.
    const decision = decisionFor("read", {
      reason: "This is the balance the goal asked for.",
      locator: { role: "cell", ordinal: 1, within: { role: "row", name: "Balance:" } },
      bind: "balance",
    });

    expect(decision).toMatchObject({ kind: "act", bind: "balance", action: { kind: "read" } });
    if (decision.kind !== "act") throw new Error("expected an act");
    expect(decision.action).not.toHaveProperty("bind");
  });

  it("leaves the bind absent when the model named nothing, rather than present and empty", () => {
    // A read binding nothing was the model looking around. Absent and set to
    // undefined are different things under `exactOptionalPropertyTypes`, and
    // the recorder drops on the absence.
    const decision = decisionFor("read", {
      reason: "Checking what this row says.",
      locator: { role: "heading", name: "Account Details" },
    });

    expect(decision).not.toHaveProperty("bind");
  });

  it("reads done as the end of the run rather than as an Action", () => {
    expect(
      decisionFor("done", { reason: "Both values are on screen.", summary: "SAVINGS, $1231.10" }),
    ).toEqual({
      kind: "done",
      reason: "Both values are on screen.",
      summary: "SAVINGS, $1231.10",
    });
  });

  it("hands back a complaint rather than throwing when the input does not fit", () => {
    // The model is told and gets to try again. Throwing here would end a run
    // over a malformed argument the next turn could have corrected.
    const decision = decisionFor("click", { reason: "Trying the link.", locator: { role: "nope" } });

    expect(decision.kind).toBe("unusable");
    if (decision.kind !== "unusable") return;
    expect(decision.complaint).toContain("locator.role");
  });

  it("refuses a verb it does not offer", () => {
    const decision = decisionFor("navigate", { reason: "Going straight there.", url: "/admin.htm" });

    expect(decision).toMatchObject({ kind: "unusable" });
    if (decision.kind !== "unusable") return;
    expect(decision.complaint).toContain("navigate");
  });
});

describe("telling the model what came back", () => {
  it("reports a read's value, which is the point of a read", () => {
    expect(reportOf({ kind: "ok", value: "-$2300.00" })).toEqual({
      text: `ok: "-$2300.00"`,
      isError: false,
    });
  });

  it("reports an Action that worked and returned nothing", () => {
    expect(reportOf({ kind: "ok" })).toEqual({ text: "ok", isError: false });
  });

  it("reports a miss as an error the model can act on", () => {
    expect(reportOf({ kind: "not-found", locator: { role: "link", name: "nope" } })).toEqual({
      text: "no control matched",
      isError: true,
    });
  });

  it("reports how many matched when a Locator was ambiguous", () => {
    expect(
      reportOf({ kind: "ambiguous", locator: { role: "link", name: "Funds" }, matches: 4 }),
    ).toEqual({ text: "4 controls matched", isError: true });
  });

  it("passes the policy gate's own words through when it refused", () => {
    expect(reportOf({ kind: "refused", reason: `"/transfer.htm" can change data.` })).toEqual({
      text: `"/transfer.htm" can change data.`,
      isError: true,
    });
  });
});
