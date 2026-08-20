import { describe, expect, it, vi } from "vitest";
import { SessionControl, type Controller } from "./controller.js";
import type { InterventionRequest } from "./intervention-request.js";

const REQUEST: InterventionRequest = {
  capability: "open-account@1",
  step: "submit",
  reason: `"/openaccount.htm" can change data, and this run has no mandate to.`,
  observed: { url: "http://localhost:8080/parabank/openaccount.htm", tree: `- heading "Open New Account"` },
};

describe("the Controller", () => {
  it("starts with the agent holding control and no request outstanding", () => {
    const control = new SessionControl();

    expect(control.controller).toBe<Controller>("agent");
    expect(control.request).toBeUndefined();
  });

  it("hands the session to the human, carrying why", () => {
    const control = new SessionControl();

    control.toHuman(REQUEST);

    expect(control.controller).toBe<Controller>("human");
    expect(control.request).toEqual(REQUEST);
  });

  it("gives control back, and stops describing a session nobody is holding", () => {
    const control = new SessionControl();
    control.toHuman(REQUEST);

    control.toAgent();

    expect(control.controller).toBe<Controller>("agent");
    // Left in place, this is how a later reader concludes the run is still
    // waiting for a person who finished ten minutes ago.
    expect(control.request).toBeUndefined();
  });

  it("refuses a second handover of a session the human already holds", () => {
    const control = new SessionControl();
    control.toHuman(REQUEST);

    // Two escalations both believing they own one session is how the first
    // one's operator gets the session taken away mid-keystroke.
    expect(() => control.toHuman(REQUEST)).toThrow(/already the human's/);
  });

  it("refuses to return control the agent already has", () => {
    const control = new SessionControl();

    expect(() => control.toAgent()).toThrow(/already the agent's/);
  });

  it("stops telling a listener that has stopped listening", () => {
    const control = new SessionControl();
    const seen = vi.fn();
    const stop = control.onChange(seen);
    control.toHuman(REQUEST);
    control.toAgent();

    stop();
    control.toHuman(REQUEST);
    control.toAgent();

    // One run can escalate twice. A listener left behind by the first handover
    // writes the second one's transitions a second time, and a trail reporting
    // one handover as two is worse than one reporting none.
    expect(seen).toHaveBeenCalledTimes(2);
  });

  it("tells its listeners on every transition, in both directions", () => {
    const control = new SessionControl();
    const seen = vi.fn();
    control.onChange(seen);

    control.toHuman(REQUEST);
    control.toAgent();

    expect(seen.mock.calls).toEqual([
      ["human", REQUEST],
      // The request is still handed to the listener on the way back, because
      // the thing that wants to log a handover ending needs to know which one
      // ended.
      ["agent", REQUEST],
    ]);
  });
});
