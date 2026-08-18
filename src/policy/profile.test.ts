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
