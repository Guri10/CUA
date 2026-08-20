/**
 * The Controller, as a decorator over `Surface` — the sibling of
 * `PolicyGatedSurface`, named to read like it.
 *
 * The spec's user story is "I want the system to know that I am in control and
 * refuse to act while I am, so that we cannot both drive at once". A check the
 * executor makes would satisfy that for the executor and for nothing else — the
 * discovery loop, the login helper and the session re-establishment all reach
 * the same page through the same interface, and a person typing into a form
 * while any one of them clicks Submit is the failure this exists to prevent.
 * So it goes where the policy gate went, for the reason the policy gate went
 * there: a rule somebody has to remember is a rule that will be missing from
 * one of the callers.
 *
 * It sits *outside* the policy gate — `Controlled(PolicyGated(Evidence(...)))`.
 * Outside, because while a person holds the session there is nothing to gate
 * and nothing to log: the Action never reaches the application, so recording it
 * as something that happened would put an agent action in the audit trail at a
 * moment the trail says the human was driving. The refusal is the caller's
 * answer, exactly as the gate's is.
 *
 * Observing stays open. The escalation itself has to read the screen to build
 * an Intervention Request, and the run that resumes has to see where the person
 * left it — neither touches anything, and blocking them would mean the agent
 * came back blind.
 */
import type { Action, ActionResult, Snapshot, Surface } from "../surface/surface.js";
import type { SessionControl } from "./controller.js";

export class ControllerGatedSurface implements Surface {
  readonly #inner: Surface;
  readonly #control: SessionControl;

  constructor(inner: Surface, control: SessionControl) {
    this.#inner = inner;
    this.#control = control;
  }

  async snapshot(): Promise<Snapshot> {
    return await this.#inner.snapshot();
  }

  async screenshot(): Promise<Buffer> {
    return await this.#inner.screenshot();
  }

  async perform(action: Action): Promise<ActionResult> {
    if (this.#control.controller === "human") {
      // A refusal rather than a throw, and the same one the gate produces, so
      // that every caller already written to read `refused` reads this too. A
      // Discovery Run turns it into an Intervention Request; Replay turns it
      // into a Hard Failure naming the Step. Both are correct answers to "the
      // agent tried to act while a person was driving", and neither needs a
      // second code path.
      return {
        kind: "refused",
        reason:
          "A human holds this session. The agent does not act until control is returned.",
      };
    }

    return await this.#inner.perform(action);
  }
}
