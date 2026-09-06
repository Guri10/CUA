import { request } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { SecretStore } from "../surface/secret-store.js";
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

  it("refuses an operator or branch the runs would not read, storing nothing", async () => {
    // Configured for super1 at MAIN-001; the runs look the password up by that
    // operator id, so a sign-on for anyone else must not appear to succeed.
    const { signOn, calls } = fakeSignOn();
    const store = new SecretStore();
    portal = await startSignOnPortal({
      signOn,
      store,
      expected: { operator: "super1", branch: "MAIN-001 - Main Office" },
      port: 0,
    });

    const wrongOperator = await post(portal.url, { ...GOOD, operator: "teller1" });
    expect(wrongOperator.status).toBe(409);

    const wrongBranch = await post(portal.url, { ...GOOD, branch: "WEST-002 - West Office" });
    expect(wrongBranch.status).toBe(409);

    // Neither reached the validator, and neither left anything in the store.
    expect(calls).toEqual([]);
    expect(store.get("teller1")).toBeUndefined();
    expect(store.get("super1")).toBeUndefined();
  });

  it("accepts the configured operator and branch when they match", async () => {
    const { signOn, calls } = fakeSignOn();
    const store = new SecretStore();
    portal = await startSignOnPortal({
      signOn,
      store,
      expected: { operator: "super1", branch: "MAIN-001 - Main Office" },
      port: 0,
    });

    const response = await post(portal.url, GOOD);

    expect(response.status).toBe(200);
    expect(calls).toEqual([GOOD]);
    expect(store.get("super1")).toBe("s3cr3t");
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
