import { describe, expect, it } from "vitest";
import { loadSurfaceProfile, surfaceProfileSchema, surfacesDir } from "./profile.js";

/**
 * The Surface profile: the description of one installation of the application.
 *
 * ADR 0005 puts it at this scope deliberately — onboarding a Tenant running the
 * same vendor product means writing a new profile rather than re-recording its
 * Capabilities. It is checked-in config rather than environment, because the
 * allowlist it carries is a safety rule a reviewer has to be able to read.
 */
describe("a Surface profile", () => {
  it("loads the committed ParaBank profile", async () => {
    const profile = await loadSurfaceProfile(surfacesDir(), "parabank");

    expect(profile.id).toBe("parabank");
    expect(profile.allowedOrigins).toContain("http://localhost:8080");
  });

  it("classifies the routes ADR 0007 names, and no others by accident", async () => {
    const profile = await loadSurfaceProfile(surfacesDir(), "parabank");

    // The ADR names these six explicitly. If the profile ever stops agreeing
    // with it, one of the two is wrong and this is where it shows.
    expect(profile.routes["read-only"]).toEqual(
      expect.arrayContaining(["/overview.htm", "/activity.htm"]),
    );
    expect(profile.routes.mutating).toEqual(
      expect.arrayContaining(["/transfer.htm", "/openaccount.htm", "/billpay.htm"]),
    );
  });

  it("declares the Recoverable Conditions ADR 0005 puts at this scope", async () => {
    // Declared once for the installation rather than copied into each
    // Capability, which is the whole reason this scope exists.
    const profile = await loadSurfaceProfile(surfacesDir(), "parabank");

    expect(profile.recoverableConditions.map((condition) => condition.name)).toEqual([
      "SESSION_EXPIRED",
    ]);
    expect(profile.recoverableConditions[0]?.recover).toBe("re-establish-session");
  });

  it("leaves an installation nobody has studied with no conditions at all", () => {
    // Deny-by-default in the other direction: a profile that declares nothing
    // absorbs nothing, and every unrecognised screen stops the run.
    const result = surfaceProfileSchema.safeParse({
      id: "unstudied",
      baseUrl: "http://localhost:8080/parabank",
      allowedOrigins: ["http://localhost:8080"],
      actions: ["navigate"],
      routes: { "read-only": [], mutating: [] },
    });

    expect(result.success && result.data.recoverableConditions).toEqual([]);
  });

  it("refuses a condition that reaches for a Capability's input", () => {
    // The profile describes the installation. Nothing at this scope knows what
    // any one Capability's inputs are, so a condition referring to one could
    // only be matched during some runs.
    const result = surfaceProfileSchema.safeParse({
      id: "too-specific",
      baseUrl: "http://localhost:8080/parabank",
      allowedOrigins: ["http://localhost:8080"],
      actions: ["navigate"],
      routes: { "read-only": [], mutating: [] },
      recoverableConditions: [
        {
          name: "SESSION_EXPIRED",
          when: {
            kind: "present",
            locator: { role: "link", name: { kind: "input", input: "accountId" } },
          },
          recover: "re-establish-session",
        },
      ],
    });

    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toMatch(/accountId/);
  });

  it("refuses two conditions under one name", () => {
    // A run that absorbed "one of the two SESSION_EXPIREDs" tells a reader
    // nothing about which screen it actually met.
    const condition = {
      name: "SESSION_EXPIRED",
      when: {
        kind: "present",
        locator: { role: "button", name: { kind: "literal", value: "Log In" } },
      },
      recover: "re-establish-session",
    };
    const result = surfaceProfileSchema.safeParse({
      id: "twice",
      baseUrl: "http://localhost:8080/parabank",
      allowedOrigins: ["http://localhost:8080"],
      actions: ["navigate"],
      routes: { "read-only": [], mutating: [] },
      recoverableConditions: [condition, condition],
    });

    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toMatch(/SESSION_EXPIRED/);
  });

  it("refuses a profile that classes one path both ways", () => {
    // A path in both lists has no answer to "may this run touch it", and the
    // answer a reader would guess depends on which list they read first.
    const result = surfaceProfileSchema.safeParse({
      id: "double",
      baseUrl: "http://localhost:8080/parabank",
      allowedOrigins: ["http://localhost:8080"],
      actions: ["navigate"],
      routes: { "read-only": ["/overview.htm"], mutating: ["/overview.htm"] },
    });

    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toMatch(/overview\.htm/);
  });

  it("refuses a base URL whose own origin is not allowed", () => {
    // The one contradiction that would make every run fail at Step one.
    const result = surfaceProfileSchema.safeParse({
      id: "elsewhere",
      baseUrl: "http://example.test/parabank",
      allowedOrigins: ["http://localhost:8080"],
      actions: ["navigate"],
      routes: { "read-only": [], mutating: [] },
    });

    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toMatch(/example\.test/);
  });

  it("refuses a path that is not a path", () => {
    const result = surfaceProfileSchema.safeParse({
      id: "bad-path",
      baseUrl: "http://localhost:8080/parabank",
      allowedOrigins: ["http://localhost:8080"],
      actions: ["navigate"],
      routes: { "read-only": ["overview.htm"], mutating: [] },
    });

    expect(result.success).toBe(false);
  });

  it("says which profile is missing rather than throwing a file error", async () => {
    await expect(loadSurfaceProfile(surfacesDir(), "no-such-bank")).rejects.toThrow(/no-such-bank/);
  });
});
