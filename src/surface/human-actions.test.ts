import { describe, expect, it } from "vitest";
import { actionFrom, capturingScript, injectableCaptureScript, CAPTURE_BINDING } from "./human-actions.js";

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
