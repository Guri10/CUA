import { describe, expect, it } from "vitest";
import { loadSurfaceProfile, surfacesDir } from "./profile.js";
import { routeOf } from "./route.js";

/**
 * The MERIDIAN Surface profile: the second installation described as data.
 *
 * What is new here versus ParaBank is route *patterns* (ADR 0009). MERIDIAN's
 * routes are keyed on a member number, which is data, not a route — so the
 * profile lists `/members/:id/transfer`, and the class comes from the verb
 * segment, never from which member the path names.
 */
describe("the MERIDIAN Surface profile", () => {
  const BASE = "https://web-sample.interface-hiring.com";

  it("loads and declares the origin the automation may reach", async () => {
    const profile = await loadSurfaceProfile(surfacesDir(), "meridian");

    expect(profile.id).toBe("meridian");
    expect(profile.allowedOrigins).toEqual([BASE]);
  });

  it("classifies a member record read-only and its transfer mutating, for any member", async () => {
    const profile = await loadSurfaceProfile(surfacesDir(), "meridian");

    // A member id the profile never lists — the point of a pattern is that it
    // classifies one it has not seen.
    expect(routeOf(profile, `${BASE}/members/778901`)).toEqual({
      allowed: true,
      route: "/members/778901",
      mutates: false,
    });
    expect(routeOf(profile, `${BASE}/members/778901/transfer`)).toEqual({
      allowed: true,
      route: "/members/778901/transfer",
      mutates: true,
    });
    expect(routeOf(profile, `${BASE}/members/778901/hold`)).toMatchObject({ mutates: true });
  });

  it("still denies a route no pattern lists", async () => {
    const profile = await loadSurfaceProfile(surfacesDir(), "meridian");

    // Deny-by-default is unchanged by patterns (ADR 0007/0009): an unclassified
    // verb is refused, not assumed safe.
    expect(routeOf(profile, `${BASE}/members/778901/wire`)).toMatchObject({ allowed: false });
  });

  it("declares both Recoverable Conditions the spec names, with their recovery kinds", async () => {
    const profile = await loadSurfaceProfile(surfacesDir(), "meridian");

    expect(
      profile.recoverableConditions.map((condition) => [condition.name, condition.recover]),
    ).toEqual([
      ["SESSION_EXPIRED", "re-establish-session"],
      ["MAINTENANCE", "retry"],
    ]);
  });
});
