import { describe, expect, it } from "vitest";
import { FakeSurface, type Script } from "../surface/fake-surface.js";
import { capturedTree, PARABANK_CAPTURED_BASE_URL as BASE } from "../surface/parabank/fake-script.js";
import type { Action, Surface } from "../surface/surface.js";
import { PolicyGatedSurface } from "./policy-gated-surface.js";
import type { SurfaceProfile } from "./profile.js";

const profile: SurfaceProfile = {
  id: "parabank",
  baseUrl: BASE,
  allowedOrigins: ["http://localhost:8080"],
  actions: ["navigate", "click", "fill", "read", "waitFor"],
  routes: { "read-only": ["/overview.htm"], mutating: ["/transfer.htm"] },
};

/**
 * The screens are the captured overview plus a stand-in for a screen we never
 * want reached. The tree of the second one is deliberately trivial: what is
 * under test is the address, not what is on it.
 */
const script: Script = {
  screens: [
    { name: "overview", url: `${BASE}/overview.htm`, tree: capturedTree("02-accounts-overview") },
    { name: "transfer", url: `${BASE}/transfer.htm`, tree: `- button "Transfer"\n` },
    { name: "admin", url: `${BASE}/admin.htm`, tree: `- button "Clean"\n` },
  ],
};

function gated(mayMutate: boolean): Surface {
  return new PolicyGatedSurface(new FakeSurface(script), profile, { mayMutate });
}

const goToOverview: Action = { kind: "navigate", url: `${BASE}/overview.htm` };

/**
 * The policy gate, as a decorator over `Surface` rather than a call the
 * executor has to remember to make.
 *
 * That is the whole design: both phases receive an already-wrapped Surface and
 * there is no unwrapped one to reach for, so ADR 0007's "one gate, both phases"
 * is structural rather than a convention. It composes over the fake here and
 * over the browser identically, because it only knows the interface.
 */
describe("the policy gate", () => {
  it("passes an allowed action through to the Surface underneath", async () => {
    const surface = gated(false);

    expect(await surface.perform(goToOverview)).toEqual({ kind: "ok" });
    expect((await surface.snapshot()).url).toBe(`${BASE}/overview.htm`);
    expect(
      await surface.perform({ kind: "click", locator: { role: "link", name: "12345", exact: true } }),
    ).toEqual({ kind: "ok" });
  });

  it.each([
    [
      "an origin nobody allowed",
      false,
      [{ kind: "navigate", url: "http://evil.test/parabank/overview.htm" }] as Action[],
      /origin http:\/\/evil\.test is not allowed/,
    ],
    [
      "a path outside the installation",
      false,
      [{ kind: "navigate", url: "http://localhost:8080/elsewhere/overview.htm" }] as Action[],
      /outside \/parabank/,
    ],
    [
      "a route the profile does not list",
      false,
      [{ kind: "navigate", url: `${BASE}/admin.htm` }] as Action[],
      /"\/admin\.htm" is not a route/,
    ],
    [
      "an action type this installation does not permit",
      false,
      [goToOverview, { kind: "select", locator: { role: "combobox" }, option: "All" }] as Action[],
      /"select" is not an action the "parabank" Surface profile permits/,
    ],
    [
      "navigating to a mutating route with no mandate to mutate",
      false,
      [{ kind: "navigate", url: `${BASE}/transfer.htm` }] as Action[],
      /"\/transfer\.htm" can change data/,
    ],
  ])("refuses %s, and says why", async (_, mayMutate, actions, reason) => {
    const surface = gated(mayMutate);

    const results = [];
    for (const action of actions) results.push(await surface.perform(action));

    const last = results.at(-1)!;
    expect(last.kind).toBe("refused");
    expect(last.kind === "refused" && last.reason).toMatch(reason);
  });

  it("refuses to act on a mutating screen the run is already standing on", async () => {
    // Reached with a mandate, then acted on without one — because a run that
    // could be refused entry can never be tested for what it does once inside.
    const inner = new FakeSurface(script);
    await inner.perform({ kind: "navigate", url: `${BASE}/transfer.htm` });
    const surface = new PolicyGatedSurface(inner, profile, { mayMutate: false });

    const result = await surface.perform({
      kind: "click",
      locator: { role: "button", name: "Transfer" },
    });

    expect(result.kind).toBe("refused");
    expect(result.kind === "refused" && result.reason).toMatch(/"\/transfer\.htm" can change data/);
  });

  it("allows a mutating route when the run has a mandate to mutate", async () => {
    // The same action, the same profile — only the mandate differs. That is
    // what makes approval the thing being enforced rather than the route.
    const surface = gated(true);

    expect(await surface.perform({ kind: "navigate", url: `${BASE}/transfer.htm` })).toEqual({
      kind: "ok",
    });
  });

  it("judges where the run already is, not only where it is going", async () => {
    // A click can land the run somewhere no navigate ever asked for. The gate
    // cannot un-click it, but checking the current screen before every action
    // means nothing can be *done* there — the refusal arrives before the first
    // action on the disallowed screen rather than after it.
    const inner = new FakeSurface(script);
    await inner.perform({ kind: "navigate", url: `${BASE}/admin.htm` });
    const surface = new PolicyGatedSurface(inner, profile, { mayMutate: true });

    const result = await surface.perform({
      kind: "click",
      locator: { role: "button", name: "Clean" },
    });

    expect(result.kind).toBe("refused");
    expect(result.kind === "refused" && result.reason).toMatch(/\/admin\.htm/);
  });

  it("refuses without touching the Surface underneath", async () => {
    // A gate that refused after dispatching would be decoration.
    const inner = new FakeSurface(script);
    const surface = new PolicyGatedSurface(inner, profile, { mayMutate: false });

    await surface.perform({ kind: "navigate", url: `${BASE}/transfer.htm` });

    expect((await inner.snapshot()).url).toBe("about:blank");
  });

  it("forwards the two methods that only observe", async () => {
    const surface = gated(false);
    await surface.perform(goToOverview);

    expect((await surface.snapshot()).tree).toContain(`- heading "Accounts Overview"`);
    expect((await surface.screenshot()).toString()).toContain("fake screenshot");
  });
});
