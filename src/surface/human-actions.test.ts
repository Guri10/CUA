import { describe, expect, it } from "vitest";
import {
  actionFrom,
  actionsFromSnapshot,
  capturingScript,
  injectableCaptureScript,
  mergeFinalState,
  snapshotExpression,
  CAPTURE_BINDING,
} from "./human-actions.js";
import type { Action } from "./surface.js";

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

/**
 * The final-state snapshot: what the form still showed when the person handed
 * the session back, for the option they picked but left on its default — no
 * change event fires for that, so the change-driven capture never sees it.
 */
describe("turning the form's final state into Actions", () => {
  it("records a value-carrying select for an option left on its default", () => {
    // The reason combobox the human left on the default `FRAUD` option: no
    // change fired, so only the final-state snapshot has it.
    expect(
      actionsFromSnapshot([
        { kind: "select", role: "combobox", name: "Reason Code", matches: 1, ordinal: 0, value: "FRAUD - Suspected fraud" },
      ]),
    ).toEqual([
      {
        kind: "select",
        locator: { role: "combobox", name: "Reason Code", exact: true },
        option: "FRAUD - Suspected fraud",
      },
    ]);
  });

  it("keeps only value-carrying controls, dropping clicks and empty fields", () => {
    expect(
      actionsFromSnapshot([
        // A button is not a form value; the snapshot never reports one, but a
        // click payload must not become a Step here either.
        { kind: "click", role: "button", name: "Apply Hold", matches: 1, ordinal: 0 },
        // An empty optional field contributes no Step (see the empty-optional
        // guard) — the snapshot omits it, and a stray one is dropped.
        { kind: "fill", role: "textbox", name: "Notes", matches: 1, ordinal: 0, value: "" },
        { kind: "fill", role: "textbox", name: "Notes", matches: 1, ordinal: 0, value: "escalated" },
      ]),
    ).toEqual([{ kind: "fill", locator: { role: "textbox", name: "Notes", exact: true }, value: "escalated" }]);
  });

  it("drops a payload the page reported in a shape nobody expected", () => {
    expect(actionsFromSnapshot([{ role: "combobox" }, "nonsense", 42])).toEqual([]);
    expect(actionsFromSnapshot("not an array")).toEqual([]);
  });

  it("folds in a final-state control no change event announced", () => {
    const captured: Action[] = [
      { kind: "fill", locator: { role: "textbox", ordinal: 0 }, value: "100234" },
    ];
    const finalState = actionsFromSnapshot([
      { kind: "select", role: "combobox", name: "Reason Code", matches: 1, ordinal: 0, value: "FRAUD - Suspected fraud" },
    ]);

    expect(mergeFinalState(captured, finalState)).toEqual([
      {
        kind: "select",
        locator: { role: "combobox", name: "Reason Code", exact: true },
        option: "FRAUD - Suspected fraud",
      },
    ]);
  });

  it("adds nothing for a control a change event already recorded", () => {
    // The human changed the reason, so the change-driven capture already has it;
    // the final-state snapshot must not record it a second time.
    const captured: Action[] = [
      {
        kind: "select",
        locator: { role: "combobox", name: "Reason Code", exact: true },
        option: "LEGAL - Legal / levy",
      },
    ];
    const finalState = actionsFromSnapshot([
      { kind: "select", role: "combobox", name: "Reason Code", matches: 1, ordinal: 0, value: "LEGAL - Legal / levy" },
    ]);

    expect(mergeFinalState(captured, finalState)).toEqual([]);
  });

  it("does not double a control that gained a same-named twin between capture and snapshot", () => {
    // Captured live when it was the only "Share" combobox, so no ordinal. By the
    // time the snapshot runs a second same-named control has rendered, so the
    // snapshot writes `ordinal: 0` for that same first control — still the one
    // the change event already recorded.
    const captured: Action[] = [
      { kind: "select", locator: { role: "combobox", name: "Share", exact: true }, option: "Regular" },
    ];
    const finalState = actionsFromSnapshot([
      { kind: "select", role: "combobox", name: "Share", matches: 2, ordinal: 0, value: "Regular" },
    ]);

    expect(mergeFinalState(captured, finalState)).toEqual([]);
  });

  it("is a page-ready expression that calls the stashed reader for the binding", () => {
    const expression = snapshotExpression(CAPTURE_BINDING);
    // Names the per-page reader installCapture stashes, and is safe when it is
    // absent (a page the script never ran on returns no controls).
    expect(expression).toContain(CAPTURE_BINDING);
    expect(eval(expression.replace(JSON.stringify(CAPTURE_BINDING + "__snapshot"), "'__missing'"))).toEqual([]);
  });
});

/**
 * The wrapper that lets the serialised listeners survive the build.
 *
 * This is the half of the capture that a browser is not needed to check, and
 * the one that a passing e2e suite hid: under Vitest the listener source has no
 * `__name` reference, so the suite ran green while the built CLI — transpiled by
 * esbuild, which injects `__name` — threw inside the page and captured nothing.
 * The regression is reproduced here by standing in a body that names `__name`,
 * exactly as a keep-names transpiler would emit, and driving it through the same
 * wrapper the surface uses.
 */
describe("injecting the capture script into the page", () => {
  // `eval` here stands in for the page's own evaluation of the injected source,
  // and only ever runs literals authored in this file — there is no external
  // input, which is the risk `eval` otherwise carries.

  // What esbuild's keep-names transform turns a nested function into: a call to
  // a `__name` helper it defines at module scope and which is therefore absent
  // once the function is serialised on its own.
  const keepNamesBody = `function (binding) { const f = __name(() => binding, "f"); return f(); }`;

  it("reproduces the dangling __name that broke the raw injection", () => {
    // Injected without the wrapper, the transpiled body is a ReferenceError —
    // thrown before a single listener is attached, so the capture is silent.
    expect(() => eval(`(${keepNamesBody})("BOUND")`)).toThrow(/__name is not defined/);
  });

  it("supplies __name so the same body runs wherever it was built", () => {
    expect(eval(injectableCaptureScript("BOUND", keepNamesBody))).toBe("BOUND");
  });

  it("wraps the real listeners into a callable expression bound to the capture name", () => {
    const install = injectableCaptureScript(CAPTURE_BINDING);

    expect(install).toContain("const __name");
    expect(install).toContain(CAPTURE_BINDING);
    // The listeners themselves, unchanged, are still in there.
    expect(install).toContain("addEventListener");
  });
});
