import { describe, expect, it } from "vitest";
import { LoginSession } from "./login-session.js";
import { SecretStore } from "./secret-store.js";

/**
 * The gated login session (#51): a receipt the portal issues, an idle clock the
 * served interactions reset, and a one-operator-per-boot lock. The clock is
 * injected so idleness is a number we move, not a wait.
 */
describe("the login session", () => {
  /** A session with a movable clock and its own store, plus a way to advance time. */
  function makeSession(idleMs: number) {
    const store = new SecretStore();
    let now = 1_000;
    const session = new LoginSession({ idleMs, store, now: () => now });
    return { session, store, advance: (ms: number) => (now += ms) };
  }

  it("is locked out until someone signs on", () => {
    const { session } = makeSession(1_000);
    expect(session.isLive()).toBe(false);
    expect(session.identity()).toBeUndefined();
    expect(session.admit()).toBe(false);
  });

  it("goes live on sign-on, reporting the operator and branch a run signs on as", () => {
    const { session } = makeSession(1_000);
    session.signOn({ operator: "teller1", branch: "MAIN-001 - Main Office" });
    expect(session.isLive()).toBe(true);
    expect(session.identity()).toEqual({ operator: "teller1", branch: "MAIN-001 - Main Office" });
    expect(session.admit()).toBe(true);
  });

  it("expires after the idle timeout and drops the password", () => {
    const { session, store, advance } = makeSession(1_000);
    store.set("teller1", "hunter2");
    session.signOn({ operator: "teller1", branch: "MAIN-001 - Main Office" });

    advance(1_001); // just past the idle window
    expect(session.isLive()).toBe(false);
    expect(session.identity()).toBeUndefined();
    expect(session.admit()).toBe(false);
    // The locked-out session cannot re-sign from a password nobody re-entered.
    expect(store.get("teller1")).toBeUndefined();
  });

  it("resets the idle clock on each admitted interaction", () => {
    const { session, advance } = makeSession(1_000);
    session.signOn({ operator: "teller1", branch: "MAIN-001 - Main Office" });

    advance(800);
    expect(session.admit()).toBe(true); // activity resets the clock
    advance(800); // 1600 since sign-on, but only 800 since the last admit
    expect(session.isLive()).toBe(true);
  });

  it("refuses a different operator once one is locked in, until restart", () => {
    const { session } = makeSession(1_000);
    session.signOn({ operator: "teller1", branch: "MAIN-001 - Main Office" });
    expect(session.accepts("teller1")).toBe(true);
    expect(session.accepts("super1")).toBe(false);
    expect(() => session.signOn({ operator: "super1", branch: "MAIN-001 - Main Office" })).toThrow(/until it restarts/i);
  });

  it("keeps the operator lock after sign-off, but re-signing as the same operator is fine", () => {
    const { session, store } = makeSession(1_000);
    store.set("teller1", "hunter2");
    session.signOn({ operator: "teller1", branch: "MAIN-001 - Main Office" });

    session.signOff();
    expect(session.isLive()).toBe(false);
    expect(store.get("teller1")).toBeUndefined(); // sign-off drops the password
    expect(session.accepts("super1")).toBe(false); // still locked to teller1
    expect(session.accepts("teller1")).toBe(true);

    store.set("teller1", "hunter2");
    session.signOn({ operator: "teller1", branch: "MAIN-001 - Main Office" });
    expect(session.isLive()).toBe(true);
  });
});
