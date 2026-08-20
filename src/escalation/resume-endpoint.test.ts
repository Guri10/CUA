import { afterEach, describe, expect, it } from "vitest";
import { SessionControl } from "./controller.js";
import type { InterventionRequest } from "./intervention-request.js";
import { openResumeEndpoint, type ResumeEndpoint } from "./resume-endpoint.js";

const REQUEST: InterventionRequest = {
  capability: "open-account@1",
  step: "submit-open-account",
  reason: `"/openaccount.htm" can change data, and this run has no mandate to.`,
  observed: {
    url: "http://localhost:8080/parabank/openaccount.htm",
    tree: `- heading "Open New Account"`,
  },
};

let endpoint: ResumeEndpoint | undefined;

afterEach(async () => {
  await endpoint?.close();
  endpoint = undefined;
});

/** Port zero: the tests must not fight each other or the operator's own run. */
async function paused(): Promise<{ endpoint: ResumeEndpoint; control: SessionControl }> {
  const control = new SessionControl();
  control.toHuman(REQUEST);
  endpoint = await openResumeEndpoint({ control, request: REQUEST, port: 0 });
  return { endpoint, control };
}

describe("the resume endpoint", () => {
  it("serves the Intervention Request, with everything a person needs to act", async () => {
    const { endpoint } = await paused();

    const read = await (await fetch(endpoint.url)).json();

    // CONTEXT.md's four: which Capability, the current Step, the observed
    // state, and why it stopped.
    expect(read).toEqual(REQUEST);
  });

  it("returns control and settles the run's wait", async () => {
    const { endpoint, control } = await paused();
    let running = false;
    void endpoint.resumed.then(() => {
      running = true;
    });

    const response = await fetch(`${endpoint.url}/resume`, { method: "POST" });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ resumed: true });
    expect(control.controller).toBe("agent");
    await endpoint.resumed;
    expect(running).toBe(true);
  });

  it("answers a second resume instead of crashing the run that is already going", async () => {
    const { endpoint } = await paused();
    await fetch(`${endpoint.url}/resume`, { method: "POST" });

    // A curl retried after a flaky connection, or an operator who clicked
    // twice. The Controller refuses the transition; this must not become the
    // exception that ends a run which had resumed correctly.
    const again = await fetch(`${endpoint.url}/resume`, { method: "POST" });

    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ resumed: false });
  });

  it("says what it holds when asked for something else", async () => {
    const { endpoint } = await paused();

    const response = await fetch(`${endpoint.url}/whatever`);

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ read: "GET /", resume: "POST /resume" });
  });

  it("stops listening once it is closed", async () => {
    const { endpoint } = await paused();
    const url = endpoint.url;

    await endpoint.close();

    // The pause is over, and an endpoint outliving it is a resume waiting to be
    // replayed against whatever the run is doing an hour later.
    await expect(fetch(url)).rejects.toThrow();
  });

  it("listens on loopback only, which is where the operator is assumed to be", async () => {
    const { endpoint } = await paused();

    expect(endpoint.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });
});
