import { describe, expect, it } from "vitest";
import { FakeSurface } from "../fake-surface.js";
import {
  capturedMeridianTree,
  meridianScript,
  MERIDIAN_CAPTURED_BASE_URL as BASE,
} from "./fake-script.js";
import { logInToMeridian, readOperatorRole } from "./login.js";

/**
 * Signing on to MERIDIAN, run against a scripted state machine with no browser
 * — the same claim `Surface` makes and `parabank/login.test.ts` checks, now for
 * the second installation. The same list of Actions `logInToMeridian` returns is
 * what `login.e2e.test.ts` (#30) will run against the real target.
 */
describe("signing on to MERIDIAN, with no browser", () => {
  it("reaches the main menu", async () => {
    const surface = new FakeSurface(meridianScript());

    // Inert placeholders: the fake advances on the button being clicked, never
    // on what was typed, so any strings prove the same thing — and ADR 0006
    // keeps real credentials out of source files.
    const actions = logInToMeridian(BASE, {
      operator: "an-operator",
      password: "a-password",
      branch: "MAIN-001 - Main Office",
    });
    const results = [];
    for (const action of actions) results.push(await surface.perform(action));

    expect(results.every((result) => result.kind === "ok")).toBe(true);
    const snapshot = await surface.snapshot();
    expect(snapshot.url).toBe(`${BASE}/menu`);
    expect(snapshot.tree).toContain(`- heading "MAIN MENU"`);
  });

  it("reads the operator role off the post-login banner", async () => {
    // ADR 0008: the target's own assertion, read from "Signed on as J. TELLER
    // (TELLER)". The captured menu was taken as a teller.
    const role = readOperatorRole(capturedMeridianTree("menu"));

    expect(role).toBe("TELLER");
  });

  it("returns undefined when no banner says a role", () => {
    // Advisory, never a guarantee: a screen without the banner is "unknown",
    // not a thrown error or a guessed role.
    expect(readOperatorRole(capturedMeridianTree("signon"))).toBeUndefined();
  });

  it("serves fixtures with the session id scrubbed", () => {
    // The menu banner carries MERIDIAN's SID. The fixture is built through the
    // always-on redactor (ADR 0006), so no live token reaches a fixture or a
    // diff — the committed capture is already masked, and the builder keeps it
    // that way rather than trusting it to be.
    const menu = capturedMeridianTree("menu");

    expect(menu).toContain("SID [REDACTED]");
    expect(menu).not.toMatch(/SID[ :=]\s*(?![[])[A-Za-z0-9_-]*[0-9]/);
  });

  it("catches a fill aimed at a field the sign-on screen does not have", async () => {
    // The inputs are unnamed, so ordinal is the only handle and a mistargeted
    // one is the likeliest way this breaks. The fake has to notice.
    const surface = new FakeSurface(meridianScript());
    await surface.perform({ kind: "navigate", url: `${BASE}/signon` });

    const result = await surface.perform({
      kind: "fill",
      locator: { role: "textbox", ordinal: 5 },
      value: "a-password",
    });

    expect(result).toEqual({ kind: "not-found", locator: { role: "textbox", ordinal: 5 } });
  });
});
