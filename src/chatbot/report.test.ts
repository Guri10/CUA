import { describe, expect, it } from "vitest";
import { report } from "./report.js";
import type { InvokeOutcome, Step } from "./types.js";

/**
 * The plain-language report, a pure function tested without a server. What each
 * outcome sounds like to the caller is the whole product of the chatbot, so it
 * is pinned here directly: the two endings the spec names by hand
 * (`MULTIPLE_MATCHES`, `NOT_FOUND`), the others humanised from their own name,
 * and the failure and escalation lines that must stay plain and leak no screen.
 */
describe("the chatbot's plain-language report", () => {
  /** One step ending in the given outcome — the report reads the last step. */
  const step = (outcome: InvokeOutcome): Step => ({
    invocation: { ref: "some-capability", inputs: {} },
    outcome,
  });

  it("asks the caller to narrow the search on several matches, and shows no candidate list", () => {
    const text = report([step({ kind: "business-outcome", name: "MULTIPLE_MATCHES", step: "select-member" })]);

    expect(text).toMatch(/narrow/i);
    expect(text).toMatch(/member number/i);
    expect(text).toMatch(/fuller last name/i);
    // The Capability returns no candidates and the report offers none: nothing
    // that reads like an enumerated list of members.
    expect(text).not.toMatch(/^\s*[-*\d]/m);
  });

  it("gives a clean 'no such member' on a lookup miss", () => {
    const text = report([step({ kind: "business-outcome", name: "NOT_FOUND", step: "wait-for-results" })]);

    expect(text).toMatch(/couldn't find/i);
  });

  it("humanises any other Business Outcome from its own name", () => {
    const held = report([step({ kind: "business-outcome", name: "SOURCE_ON_HOLD", step: "review" })]);
    const funds = report([step({ kind: "business-outcome", name: "INSUFFICIENT_FUNDS", step: "review" })]);
    const supervisor = report([
      step({ kind: "business-outcome", name: "SUPERVISOR_OVERRIDE_REQUIRED", step: "review" }),
    ]);

    expect(held).toMatch(/source on hold/i);
    expect(funds).toMatch(/insufficient funds/i);
    expect(supervisor).toMatch(/supervisor override required/i);
  });

  it("reports success with the structured result", () => {
    const text = report([step({ kind: "success", outputs: { confirmationNumber: "CN480243" } })]);

    expect(text).toMatch(/done/i);
    expect(text).toContain("confirmationNumber: CN480243");
  });

  it("fans a list of records out under its name, one line each", () => {
    const text = report([
      step({
        kind: "success",
        outputs: {
          shares: [
            { shareId: "100234-S0001", type: "Regular Shares", balance: "$2,499.00", status: "OPEN" },
            { shareId: "100234-S0002", type: "Share Draft", balance: "$40.00", status: "HOLD" },
          ],
        },
      }),
    ]);

    expect(text).toContain("shares:");
    expect(text).toContain("100234-S0001 · Regular Shares · $2,499.00 · OPEN");
    expect(text).toContain("100234-S0002 · Share Draft · $40.00 · HOLD");
  });

  it("reports a Hard Failure plainly, without leaking the observed screen", () => {
    const text = report([
      step({
        kind: "hard-failure",
        step: "wait-for-record",
        expected: "the member record",
        observed: "an unexpected maintenance page",
        url: "https://web-sample.interface-hiring.com/members/100234",
      }),
    ]);

    expect(text).toMatch(/couldn't be completed/i);
    expect(text).toContain("wait-for-record");
    expect(text).not.toContain("maintenance page");
    expect(text).not.toContain("web-sample");
  });

  it("reports an escalation as a stopped-with-context result, in plain words", () => {
    const text = report([
      step({
        kind: "escalated",
        context: {
          capability: "funds-transfer@1",
          step: "the policy gate, before the run started",
          reason: "This Capability is a draft and mutates, so it needs approval before it runs.",
        },
      }),
    ]);

    expect(text).toMatch(/sign off/i);
    expect(text).toMatch(/draft/i);
    expect(text).toMatch(/stopped before/i);
  });

  it("reports a rejected request in the catalog's own words", () => {
    const text = report([step({ kind: "rejected", status: 404, error: "No such Capability." })]);

    expect(text).toContain("No such Capability.");
  });

  it("reports the last step of a chain, so resolve-then-act reports the act", () => {
    const text = report([
      step({ kind: "success", outputs: { memberNumber: "100234", name: "Lovelace, Ada" } }),
      step({ kind: "success", outputs: { confirmationNumber: "CN480243" } }),
    ]);

    expect(text).toContain("confirmationNumber: CN480243");
    expect(text).not.toContain("Lovelace");
  });

  it("says so plainly when nothing could be done", () => {
    expect(report([])).toMatch(/couldn't/i);
  });
});
