/**
 * Who holds the right to act on a live session, and the only two ways that
 * changes.
 *
 * CONTEXT.md makes the Controller a first-class value for a reason the spec
 * states as a user story: "we cannot both drive at once". A boolean called
 * `paused` would say the automation has stopped without saying that somebody
 * else has started, and the two are not the same claim — a run that stopped
 * because a page was slow and a run that stopped because a person is typing
 * into it need different answers to "may I act now".
 *
 * The transitions are explicit and refuse to be made twice. Handing over a
 * session that is already a human's would mean two escalations believe they own
 * it, and the second one's resume would return control the first is still
 * using. That is a programming error rather than a state of the application, so
 * it throws — the same line this codebase draws in `successStateOf`.
 */
import type { InterventionRequest } from "./intervention-request.js";

/** Exactly one at a time. CONTEXT.md's Controller, as a value. */
export type Controller = "agent" | "human";

/** Told on every transition, so evidence and the endpoint follow the same state. */
export type ControlListener = (controller: Controller, request: InterventionRequest) => void;

/**
 * The Controller, held and moved.
 *
 * Named for the session rather than called `Control`, because "a control" means
 * something else in every other file here — the thing on the Surface that a
 * Locator addresses. One word for both, in modules that import each other,
 * would make `control.name` ambiguous at exactly the moment somebody is reading
 * carefully.
 */
export class SessionControl {
  #controller: Controller = "agent";
  /** Set for exactly as long as the human holds control, and read by both. */
  #request: InterventionRequest | undefined;
  readonly #listeners: ControlListener[] = [];

  /** Who may act right now. */
  get controller(): Controller {
    return this.#controller;
  }

  /**
   * Why control was handed over, while it is held. Absent under the agent:
   * an Intervention Request describes a session a person is holding, and one
   * left lying around after resume would let a later reader think the run was
   * still waiting.
   */
  get request(): InterventionRequest | undefined {
    return this.#request;
  }

  /**
   * Told on every transition until the returned function is called.
   *
   * It returns a way to stop listening because one run can escalate more than
   * once, and a listener left behind by the first handover writes the second
   * one's transitions a second time. An audit trail that reports one handover
   * as two is worse than one that reports none.
   */
  onChange(listener: ControlListener): () => void {
    this.#listeners.push(listener);
    return () => {
      const at = this.#listeners.indexOf(listener);
      if (at !== -1) this.#listeners.splice(at, 1);
    };
  }

  /** The agent stops, and the person at the machine takes the session over. */
  toHuman(request: InterventionRequest): void {
    if (this.#controller === "human") {
      throw new Error(
        "Control is already the human's. A second handover would let two escalations " +
          "believe they own one session.",
      );
    }
    this.#controller = "human";
    this.#request = request;
    this.#announce(request);
  }

  /** The person signals they are done, and the run continues. */
  toAgent(): void {
    const request = this.#request;
    if (this.#controller === "agent" || request === undefined) {
      throw new Error("Control is already the agent's. There is nothing to return.");
    }
    this.#controller = "agent";
    this.#request = undefined;
    this.#announce(request);
  }

  #announce(request: InterventionRequest): void {
    for (const listener of this.#listeners) listener(this.#controller, request);
  }
}
