import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadSurfaceProfile, surfacesDir, type SurfaceProfile } from "../policy/profile.js";
import { logInToMeridian } from "./meridian/login.js";
import { logInToParabank } from "./parabank/login.js";
import { sessionEstablisherFor } from "./session.js";
import type { Action, ActionResult, Snapshot, Surface } from "./surface.js";

/**
 * The sign-on adapter picks the right login for the Surface a Capability names,
 * so the CLI signs into MERIDIAN or ParaBank without either being wired in by
 * hand. What is proven is the choice: given a profile, it drives that surface's
 * own login flow and carries that surface's password as the Secret to redact.
 */
const BASE = "https://example.test";

/** A Surface that records what it was asked to do and always succeeds. */
class RecordingSurface implements Surface {
  readonly performed: Action[] = [];
  async perform(action: Action): Promise<ActionResult> {
    this.performed.push(action);
    return { kind: "ok" };
  }
  async snapshot(): Promise<Snapshot> {
    return { url: BASE, tree: "", nodes: [] };
  }
  async screenshot(): Promise<Buffer> {
    return Buffer.from("");
  }
}

describe("the session establisher for a Surface", () => {
  const saved = { ...process.env };
  beforeEach(() => {
    process.env["PARABANK_USERNAME"] = "john";
    process.env["PARABANK_PASSWORD"] = "parabank-secret";
    process.env["MERIDIAN_OPERATOR"] = "super1";
    process.env["MERIDIAN_PASSWORD"] = "meridian-secret";
    process.env["MERIDIAN_BRANCH"] = "MAIN-001 - Main Office";
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  it("drives the MERIDIAN sign-on, with the operator password as the Secret", async () => {
    const profile = await loadSurfaceProfile(surfacesDir(), "meridian");
    const session = sessionEstablisherFor(profile);

    expect(session.secret).toBe("meridian-secret");

    const surface = new RecordingSurface();
    await session.establish(surface, BASE);

    // Exactly the MERIDIAN login flow, from the env credentials — not ParaBank's.
    expect(surface.performed).toEqual(
      logInToMeridian(BASE, {
        operator: "super1",
        password: "meridian-secret",
        branch: "MAIN-001 - Main Office",
      }),
    );
  });

  it("drives the ParaBank sign-on for the parabank profile", async () => {
    const profile = await loadSurfaceProfile(surfacesDir(), "parabank");
    const session = sessionEstablisherFor(profile);

    expect(session.secret).toBe("parabank-secret");

    const surface = new RecordingSurface();
    await session.establish(surface, BASE);

    expect(surface.performed).toEqual(
      logInToParabank(BASE, { username: "john", password: "parabank-secret" }),
    );
  });

  it("refuses a surface it has no sign-on for, before any browser opens", () => {
    // Deny-by-default: an unrecognised surface is a configuration error named
    // now, not a mystified miss on a login screen later.
    expect(() => sessionEstablisherFor({ id: "mystery" } as SurfaceProfile)).toThrow(
      /no sign-on is configured for the "mystery" surface/i,
    );
  });

  it("reports which credential is missing rather than launching a browser", async () => {
    delete process.env["MERIDIAN_PASSWORD"];
    const profile = await loadSurfaceProfile(surfacesDir(), "meridian");

    expect(() => sessionEstablisherFor(profile)).toThrow(/MERIDIAN_PASSWORD is not set/);
  });
});
