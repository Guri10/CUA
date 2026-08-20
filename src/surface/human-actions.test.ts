import { describe, expect, it } from "vitest";
import { actionFrom, capturingScript, CAPTURE_BINDING } from "./human-actions.js";

/**
 * The half of the capture that runs here.
 *
 * The listeners themselves can only be checked against a real browser, and
 * `escalation.e2e.test.ts` is where that happens — it drives a page as a person
 * would, then replays every captured Locator back through `getByRole` to say
 * the two halves agree about what a control is called. What this file holds is
 * the decision the Node side makes: which payloads become Steps a Recording
 * could carry, and which are dropped rather than guessed at.
 */
describe("turning what a person did into an Action", () => {
  it("addresses a named control by role and name, matched whole", () => {
    expect(actionFrom({ kind: "click", role: "link", name: "Open New Account", matches: 1, ordinal: 0 }))
      .toEqual({
        kind: "click",
        // Exact, because the name was derived whole rather than typed by
        // somebody choosing a substring. ParaBank lists account numbers whose
        // names are prefixes of one another, and a captured `12345` that
        // matched `123456` would be a Recording that reads the wrong row.
        locator: { role: "link", name: "Open New Account", exact: true },
      });
  });

  it("addresses an unnamed control by role alone", () => {
    // ADR 0001's verified note: ParaBank's login inputs carry no accessible
    // name at all and are reachable only as the first and second textbox.
    expect(actionFrom({ kind: "fill", role: "textbox", name: "", matches: 2, ordinal: 1, value: "hunter" }))
      .toEqual({ kind: "fill", locator: { role: "textbox", ordinal: 1 }, value: "hunter" });
  });

  it("carries an ordinal only when the Locator needs one to mean one control", () => {
    const alone = actionFrom({ kind: "click", role: "button", name: "Go", matches: 1, ordinal: 0 });
    const oneOfFour = actionFrom({ kind: "click", role: "button", name: "Go", matches: 4, ordinal: 2 });

    expect(alone).toEqual({ kind: "click", locator: { role: "button", name: "Go", exact: true } });
    expect(oneOfFour).toEqual({
      kind: "click",
      locator: { role: "button", name: "Go", exact: true, ordinal: 2 },
    });
  });

  it("records a chosen option by the text the person read", () => {
    expect(
      actionFrom({ kind: "select", role: "combobox", name: "Account Type", matches: 1, ordinal: 0, value: "SAVINGS" }),
    ).toEqual({
      kind: "select",
      locator: { role: "combobox", name: "Account Type", exact: true },
      option: "SAVINGS",
    });
  });

  it("drops a control whose role is outside the vocabulary rather than inventing a Locator", () => {
    // A click on a decorative div, or on a role this codebase has no name for.
    // A Step nothing could ever replay is worse than a Step that is missing:
    // the operator folding the capture into a Recording would have no way to
    // tell it apart from one that works.
    expect(actionFrom({ kind: "click", role: "carousel", name: "Next", matches: 1, ordinal: 0 })).toBeUndefined();
  });

  it("drops a payload the page reported in a shape nobody expects", () => {
    // It arrives from a script running in a page this system does not own.
    expect(actionFrom({ kind: "click", role: "link" })).toBeUndefined();
    expect(actionFrom({ kind: "punch", role: "link", name: "x", matches: 1, ordinal: 0 })).toBeUndefined();
    expect(actionFrom(undefined)).toBeUndefined();
    // A fill with nothing typed is not a fill.
    expect(actionFrom({ kind: "fill", role: "textbox", name: "", matches: 1, ordinal: 0 })).toBeUndefined();
  });

  it("hands the page a self-contained function that calls the binding by name", () => {
    const script = capturingScript();

    // Injected as source text, so anything it closed over here would be absent
    // on the other side. These are the two things it must carry itself.
    expect(script).toMatch(/^function /);
    expect(script).toContain("addEventListener");
    expect(script).not.toContain("actionFrom");
    expect(CAPTURE_BINDING).toBe("__cuaHumanAction");
  });
});
