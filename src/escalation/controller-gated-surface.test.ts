import { describe, expect, it } from "vitest";
import { FakeSurface } from "../surface/fake-surface.js";
import { parabankScript } from "../surface/parabank/fake-script.js";
import type { Action } from "../surface/surface.js";
import { SessionControl } from "./controller.js";
import { ControllerGatedSurface } from "./controller-gated-surface.js";
import type { InterventionRequest } from "./intervention-request.js";

const REQUEST: InterventionRequest = {
  capability: "open-account@1",
  step: "submit",
  reason: "risky",
  observed: { url: "http://localhost:8080/parabank/openaccount.htm", tree: "- document" },
};

const LOOK: Action = { kind: "waitFor", locator: { role: "heading", name: "Accounts Overview" } };

function controlled(): { surface: ControllerGatedSurface; control: SessionControl } {
  const control = new SessionControl();
  return { surface: new ControllerGatedSurface(new FakeSurface(parabankScript()), control), control };
}

describe("the executor while a human holds the session", () => {
  it("acts normally under the agent", async () => {
    const { surface } = controlled();

    expect(await surface.perform({ kind: "navigate", url: "http://localhost:8080/parabank/overview.htm" }))
      .toEqual({ kind: "ok" });
    expect(await surface.perform(LOOK)).toEqual({ kind: "ok" });
  });

  it("refuses to act at all once control is the human's", async () => {
    const { surface, control } = controlled();
    await surface.perform({ kind: "navigate", url: "http://localhost:8080/parabank/overview.htm" });

    control.toHuman(REQUEST);

    // Every verb, not only the ones that change something: a click on a link
    // while a person is filling in the form beside it takes the page out from
    // under them just as effectively as a submit does.
    for (const action of [
      LOOK,
      { kind: "click", locator: { role: "link", name: "Accounts Overview" } },
      { kind: "fill", locator: { role: "textbox", ordinal: 0 }, value: "12345" },
      { kind: "navigate", url: "http://localhost:8080/parabank/overview.htm" },
    ] satisfies Action[]) {
      expect(await surface.perform(action)).toEqual({
        kind: "refused",
        reason: "A human holds this session. The agent does not act until control is returned.",
      });
    }
  });

  it("still lets the run see the screen the person is working on", async () => {
    const { surface, control } = controlled();
    await surface.perform({ kind: "navigate", url: "http://localhost:8080/parabank/overview.htm" });
    control.toHuman(REQUEST);

    // The escalation has to read the screen to describe it, and the resumed run
    // has to see where it was left. Neither touches anything.
    expect((await surface.snapshot()).url).toContain("overview.htm");
    expect(await surface.screenshot()).toBeInstanceOf(Buffer);
  });

  it("acts again the moment control comes back", async () => {
    const { surface, control } = controlled();
    await surface.perform({ kind: "navigate", url: "http://localhost:8080/parabank/overview.htm" });
    control.toHuman(REQUEST);

    control.toAgent();

    expect(await surface.perform(LOOK)).toEqual({ kind: "ok" });
  });
});
