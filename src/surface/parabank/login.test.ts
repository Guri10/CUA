import { describe, expect, it } from "vitest";
import { FakeSurface } from "../fake-surface.js";
import { parabankScript, PARABANK_CAPTURED_BASE_URL } from "./fake-script.js";
import { logInToParabank } from "./login.js";

/**
 * The same list of Actions the real browser runs in `login.e2e.test.ts`, run
 * here against a scripted state machine with no browser at all.
 *
 * That is the claim `Surface` makes, checked rather than asserted: if driving
 * an application really does decompose into snapshot, perform, and screenshot,
 * then an interaction written against the interface should not be able to tell
 * which implementation it got.
 */
describe("logging in to ParaBank, with no browser", () => {
  it("runs the same interaction the real browser runs", async () => {
    const surface = new FakeSurface(parabankScript());

    // Not the container's demo credentials, and deliberately so: ADR 0006 keeps
    // credential values out of every source file. The fake never looks at
    // either string — a transition fires on the control that was acted on, not
    // on what was typed into it — so any placeholder proves the same thing.
    const actions = logInToParabank(PARABANK_CAPTURED_BASE_URL, {
      username: "a-username",
      password: "a-password",
    });
    const results = [];
    for (const action of actions) results.push(await surface.perform(action));

    expect(results).toHaveLength(6);
    expect(results.every((result) => result.kind === "ok")).toBe(true);
    const snapshot = await surface.snapshot();
    expect(snapshot.url).toBe(`${PARABANK_CAPTURED_BASE_URL}/overview.htm`);
    expect(snapshot.tree).toContain(`- heading "Accounts Overview"`);
  });

  it("catches a fill aimed at a textbox the login screen does not have", async () => {
    // ParaBank's login inputs are unnamed, so ordinal is the only handle on
    // them and a mistargeted one is the likeliest way this Recording breaks.
    // The fake has to notice, or it is not evidence of anything.
    const surface = new FakeSurface(parabankScript());
    await surface.perform({ kind: "navigate", url: `${PARABANK_CAPTURED_BASE_URL}/index.htm` });

    const result = await surface.perform({
      kind: "fill",
      locator: { role: "textbox", ordinal: 2 },
      value: "a-password",
    });

    expect(result).toEqual({ kind: "not-found", locator: { role: "textbox", ordinal: 2 } });
  });
});
