import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadSurfaceProfile, surfacesDir, type SurfaceProfile } from "../policy/profile.js";
import { logInToMeridian } from "./meridian/login.js";
import { logInToParabank } from "./parabank/login.js";
import { SecretStore } from "./secret-store.js";
import { sessionEstablisherFor } from "./session.js";
import type { Action, ActionResult, Snapshot, Surface } from "./surface.js";

/**
 * The sign-on adapter picks the right login for the Surface a Capability names,
 * so the CLI signs into MERIDIAN or ParaBank without either being wired in by
 * hand. What is proven is the choice: given a profile, it drives that surface's
 * own login flow and carries that surface's password as the Secret to redact —
 * and, for MERIDIAN, that the password comes from the in-memory store keyed by
 * the operator id (#42), not from the environment.
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
    // No MERIDIAN_PASSWORD in the environment by default: the password's source
    // is the store, and each test supplies its own store.
    delete process.env["MERIDIAN_PASSWORD"];
    process.env["MERIDIAN_BRANCH"] = "MAIN-001 - Main Office";
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  it("reads the operator password from the store, not the environment", async () => {
    // The store holds the password for this operator; the environment holds none.
    const store = new SecretStore();
    store.set("super1", "meridian-secret");
    const profile = await loadSurfaceProfile(surfacesDir(), "meridian");
    const session = sessionEstablisherFor(profile, store);

    expect(session.secret).toBe("meridian-secret");

    const surface = new RecordingSurface();
    await session.establish(surface, BASE);

    // Exactly the MERIDIAN login flow, with the stored password — not ParaBank's.
    expect(surface.performed).toEqual(
      logInToMeridian(BASE, {
        operator: "super1",
        password: "meridian-secret",
        branch: "MAIN-001 - Main Office",
      }),
    );
  });

  it("seeds the store from the environment until the portal fills it (#44/#45 bridge)", async () => {
    // Empty store, but MERIDIAN_PASSWORD set: the run signs on with it and the
    // store now holds it, so the env value is used exactly once as a bridge.
    process.env["MERIDIAN_PASSWORD"] = "meridian-secret";
    const store = new SecretStore();
    const profile = await loadSurfaceProfile(surfacesDir(), "meridian");
    const session = sessionEstablisherFor(profile, store);

    expect(session.secret).toBe("meridian-secret");
    expect(store.get("super1")).toBe("meridian-secret");
  });

  it("signs on as the portal-chosen operator when a served identity is given, never the environment", async () => {
    // Served path (#51): identity carries the operator and branch; the env names a
    // different operator, which must be ignored. The password is the store's.
    process.env["MERIDIAN_OPERATOR"] = "teller1";
    process.env["MERIDIAN_PASSWORD"] = "env-secret";
    const store = new SecretStore();
    store.set("super1", "portal-secret");
    const profile = await loadSurfaceProfile(surfacesDir(), "meridian");
    const session = sessionEstablisherFor(profile, store, { operator: "super1", branch: "EAST-022 - Eastgate" });

    expect(session.secret).toBe("portal-secret");

    const surface = new RecordingSurface();
    await session.establish(surface, BASE);
    expect(surface.performed).toEqual(
      logInToMeridian(BASE, { operator: "super1", password: "portal-secret", branch: "EAST-022 - Eastgate" }),
    );
  });

  it("does not fall back to the env password for a served identity", async () => {
    // The seed exists, but a served run must not use it — only a portal-entered
    // password, so the login gate cannot be bypassed.
    process.env["MERIDIAN_PASSWORD"] = "env-secret";
    const store = new SecretStore();
    const profile = await loadSurfaceProfile(surfacesDir(), "meridian");

    expect(() => sessionEstablisherFor(profile, store, { operator: "super1", branch: "MAIN-001 - Main Office" })).toThrow(
      /No password for operator "super1" in the secret store/i,
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

  it("reports no password rather than launching a browser", async () => {
    // Nothing in the store for this operator, and no env bridge either.
    const store = new SecretStore();
    const profile = await loadSurfaceProfile(surfacesDir(), "meridian");

    expect(() => sessionEstablisherFor(profile, store)).toThrow(
      /No password for operator "super1" in the secret store/i,
    );
  });
});
