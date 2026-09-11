import { request } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SecretStore } from "../surface/secret-store.js";
import { LoginSession } from "../surface/login-session.js";
import { startSignOnPortal, type SignOn, type SignOnPortal } from "./serve.js";

/**
 * The sign-on portal's two routes, over real HTTP with a fake validator in place
 * of the browser. What matters here is exactly the ticket's contract (#44): a
 * good sign-on puts the password in the store and reports who is signed on; a bad
 * one fails fast and stores nothing; and the password never rides back in a
 * response — not in the success body, not in an error, whatever the validator
 * says.
 */
describe("the sign-on portal", () => {
  let portal: SignOnPortal | undefined;

  afterEach(async () => {
    await portal?.close();
    portal = undefined;
  });

  /** A validator that records its calls and answers however a test tells it to. */
  function fakeSignOn(
    reply: SignOn = async ({ operator }) => ({ operator, role: "SUPERVISOR" }),
  ): { signOn: SignOn; calls: { operator: string; branch: string; password: string }[] } {
    const calls: { operator: string; branch: string; password: string }[] = [];
    const signOn: SignOn = async (req) => {
      calls.push(req);
      return reply(req);
    };
    return { signOn, calls };
  }

  const GOOD = { operator: "super1", branch: "MAIN-001 - Main Office", password: "s3cr3t" };

  async function post(url: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
    return fetch(`${url}/signon`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  }

  it("serves the sign-on form at GET /", async () => {
    const { signOn } = fakeSignOn();
    portal = await startSignOnPortal({ signOn, store: new SecretStore(), port: 0 });

    const response = await fetch(`${portal.url}/`);
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(html).toContain("MERIDIAN");
    expect(html.toLowerCase()).toContain("password");
  });

  it("stores the password and reports who is signed on when the validator accepts", async () => {
    const { signOn, calls } = fakeSignOn();
    const store = new SecretStore();
    portal = await startSignOnPortal({ signOn, store, port: 0 });

    const response = await post(portal.url, GOOD);
    const body = (await response.json()) as { operator?: string; role?: string; signedOnAs?: string };

    expect(response.status).toBe(200);
    // Validated exactly once, with what the operator submitted.
    expect(calls).toEqual([GOOD]);
    // The store now holds the password keyed by the operator id.
    expect(store.get("super1")).toBe("s3cr3t");
    // The response says who is signed on, and carries no password.
    expect(body.operator).toBe("super1");
    expect(body.role).toBe("SUPERVISOR");
    expect(JSON.stringify(body)).not.toContain("s3cr3t");
  });

  it("fails fast and stores nothing when the validator rejects the login", async () => {
    const { signOn } = fakeSignOn(async () => {
      throw new Error("Sign-on failed: never reached MAIN MENU.");
    });
    const store = new SecretStore();
    portal = await startSignOnPortal({ signOn, store, port: 0 });

    const response = await post(portal.url, GOOD);
    const body = (await response.json()) as { error?: string };

    expect(response.status).toBe(401);
    expect(body.error).toMatch(/never reached MAIN MENU/);
    // A bad login leaves the store exactly as empty as it found it.
    expect(store.get("super1")).toBeUndefined();
  });

  it("never lets the password back out, even in a validator's error text", async () => {
    // A validator that carelessly puts the submitted password in its error must
    // not be able to leak it through the portal's response.
    const { signOn } = fakeSignOn(async ({ password }) => {
      throw new Error(`bad password "${password}" for this operator`);
    });
    const store = new SecretStore();
    portal = await startSignOnPortal({ signOn, store, port: 0 });

    const response = await post(portal.url, GOOD);
    const text = await response.text();

    expect(response.status).toBe(401);
    expect(text).not.toContain("s3cr3t");
    expect(store.get("super1")).toBeUndefined();
  });

  it("marks the served session live as the operator who signed on (#51)", async () => {
    const { signOn } = fakeSignOn();
    const store = new SecretStore();
    const session = new LoginSession({ idleMs: 60_000, store });
    portal = await startSignOnPortal({ signOn, store, session, port: 0 });

    expect(session.isLive()).toBe(false);
    const response = await post(portal.url, GOOD);

    expect(response.status).toBe(200);
    expect(session.isLive()).toBe(true);
    expect(session.identity()).toEqual({ operator: "super1", branch: "MAIN-001 - Main Office" });
  });

  it("refuses a different operator once one is locked in, without driving the browser (#51)", async () => {
    // Any operator is accepted first; the second, different one is refused until
    // restart — one operator per boot — and never reaches the validator.
    const { signOn, calls } = fakeSignOn();
    const store = new SecretStore();
    const session = new LoginSession({ idleMs: 60_000, store });
    portal = await startSignOnPortal({ signOn, store, session, port: 0 });

    expect((await post(portal.url, GOOD)).status).toBe(200); // locks onto super1
    const different = await post(portal.url, { ...GOOD, operator: "teller1" });

    expect(different.status).toBe(409);
    expect(((await different.json()) as { error?: string }).error).toMatch(/until it restarts/i);
    // Only the first, accepted sign-on reached the validator.
    expect(calls).toEqual([GOOD]);
    expect(store.get("teller1")).toBeUndefined();
  });

  it("stores no losing operator's password when two different sign-ons race (#51)", async () => {
    // Both submissions pass the pre-validation `accepts` check while nothing is
    // locked; the winner takes the lock, and the loser must be refused *before*
    // its validated password is stored, so no orphan lingers.
    const store = new SecretStore();
    const session = new LoginSession({ idleMs: 60_000, store });
    const release = new Map<string, () => void>();
    const signOn: SignOn = (req) =>
      new Promise((resolve) => release.set(req.operator, () => resolve({ operator: req.operator, role: "TELLER" })));
    portal = await startSignOnPortal({ signOn, store, session, port: 0 });

    const first = post(portal.url, { ...GOOD, operator: "teller1" });
    const second = post(portal.url, { ...GOOD, operator: "super1" });
    await vi.waitFor(() => expect(release.size).toBe(2)); // both are in the validator

    release.get("teller1")!(); // teller1 wins the lock
    expect((await first).status).toBe(200);
    release.get("super1")!(); // super1 loses
    expect((await second).status).toBe(409);

    expect(store.get("teller1")).toBe("s3cr3t");
    expect(store.get("super1")).toBeUndefined(); // no orphaned password
  });

  it("signs off, clearing the session and dropping the password (#51)", async () => {
    const { signOn } = fakeSignOn();
    const store = new SecretStore();
    const session = new LoginSession({ idleMs: 60_000, store });
    portal = await startSignOnPortal({ signOn, store, session, port: 0 });

    await post(portal.url, GOOD);
    expect(session.isLive()).toBe(true);

    const off = await fetch(`${portal.url}/signoff`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(off.status).toBe(200);
    expect(session.isLive()).toBe(false);
    expect(store.get("super1")).toBeUndefined();
  });

  it("requires a JSON content-type on sign-off, so a cross-origin POST cannot end the session (#51)", async () => {
    const { signOn } = fakeSignOn();
    const store = new SecretStore();
    const session = new LoginSession({ idleMs: 60_000, store });
    portal = await startSignOnPortal({ signOn, store, session, port: 0 });

    await post(portal.url, GOOD);
    expect(session.isLive()).toBe(true);

    // A "simple" cross-origin POST carries no JSON content-type and needs no
    // preflight — the CSRF defense is to refuse it.
    const bare = await fetch(`${portal.url}/signoff`, { method: "POST" });
    expect(bare.status).toBe(415);
    expect(session.isLive()).toBe(true); // still signed on
  });

  it("turns away a body that is empty, not JSON, or not an object", async () => {
    const { signOn } = fakeSignOn();
    portal = await startSignOnPortal({ signOn, store: new SecretStore(), port: 0 });

    const empty = await fetch(`${portal.url}/signon`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "",
    });
    const notJson = await fetch(`${portal.url}/signon`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    const notObject = await fetch(`${portal.url}/signon`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "[1, 2, 3]",
    });

    expect(empty.status).toBe(400);
    expect(notJson.status).toBe(400);
    expect(notObject.status).toBe(400);
  });

  it("turns away a submission missing a field", async () => {
    const { signOn, calls } = fakeSignOn();
    portal = await startSignOnPortal({ signOn, store: new SecretStore(), port: 0 });

    const response = await post(portal.url, { operator: "super1", branch: "MAIN-001 - Main Office" });

    expect(response.status).toBe(400);
    // Nothing was validated: the request never reached the browser.
    expect(calls).toEqual([]);
  });

  it("requires a JSON content-type", async () => {
    const { signOn } = fakeSignOn();
    portal = await startSignOnPortal({ signOn, store: new SecretStore(), port: 0 });

    const response = await fetch(`${portal.url}/signon`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: JSON.stringify(GOOD),
    });

    expect(response.status).toBe(415);
  });

  it("only answers requests addressed to it on loopback", async () => {
    const { signOn } = fakeSignOn();
    portal = await startSignOnPortal({ signOn, store: new SecretStore(), port: 0 });

    const status = await new Promise<number>((resolve, reject) => {
      const url = new URL(`${portal!.url}/signon`);
      const req = request(
        {
          hostname: url.hostname,
          port: url.port,
          path: "/signon",
          method: "POST",
          // A DNS-rebinding request carries a foreign Host header.
          headers: { "content-type": "application/json", host: "attacker.example" },
        },
        (res) => resolve(res.statusCode ?? 0),
      );
      req.on("error", reject);
      req.end(JSON.stringify(GOOD));
    });

    expect(status).toBe(403);
  });

  it("has one route to post to", async () => {
    const { signOn } = fakeSignOn();
    portal = await startSignOnPortal({ signOn, store: new SecretStore(), port: 0 });

    const response = await fetch(`${portal.url}/nowhere`);
    expect(response.status).toBe(404);
  });
});
