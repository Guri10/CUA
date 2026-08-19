/**
 * The policy gate, as a decorator over `Surface`.
 *
 * A decorator rather than a check the executor calls, because a check somebody
 * has to remember to make is a check that will eventually be forgotten in one
 * of the two phases. Discovery and Replay both receive an already-wrapped
 * Surface and there is no unwrapped one to reach for, which makes ADR 0007's
 * "one gate, both phases" structural. It composes over the browser and over the
 * fake identically, because it knows only the interface.
 *
 * It answers three questions before every dispatch, in the order that a reader
 * of ADR 0007 would ask them: is this verb permitted here at all, is this
 * address one we are authorised to be at, and can being there change anything
 * this run has no mandate to change.
 */
import type { Action, ActionResult, Snapshot, Surface } from "../surface/surface.js";
import type { SurfaceProfile } from "./profile.js";
import { routeOf } from "./route.js";

export interface PolicyMandate {
  /**
   * Whether this run may touch a route that can change data.
   *
   * Decided once, before the run starts, from the Capability's declared effects
   * and its approval state — never by the model, and never from what a control
   * happens to be labelled (ADR 0007).
   */
  readonly mayMutate: boolean;
}

export class PolicyGatedSurface implements Surface {
  readonly #inner: Surface;
  readonly #profile: SurfaceProfile;
  readonly #mandate: PolicyMandate;

  constructor(inner: Surface, profile: SurfaceProfile, mandate: PolicyMandate) {
    this.#inner = inner;
    this.#profile = profile;
    this.#mandate = mandate;
  }

  /** Observing changes nothing, so it passes straight through. */
  async snapshot(): Promise<Snapshot> {
    return await this.#inner.snapshot();
  }

  async screenshot(): Promise<Buffer> {
    return await this.#inner.screenshot();
  }

  async perform(action: Action): Promise<ActionResult> {
    const refusal = await this.#refusalFor(action);
    // Before dispatch, never after. A gate that refused an action it had
    // already performed would be decoration.
    if (refusal !== undefined) return { kind: "refused", reason: refusal };

    return await this.#inner.perform(action);
  }

  async #refusalFor(action: Action): Promise<string | undefined> {
    if (!this.#profile.actions.includes(action.kind)) {
      return `"${action.kind}" is not an action the "${this.#profile.id}" Surface profile permits.`;
    }

    // Where a navigate is going, and where everything else already is.
    //
    // Judging the current screen matters because a click can land the run
    // somewhere no navigate ever asked for — following a link is a navigation
    // the gate never sees. It cannot un-click that, but checking before every
    // action means nothing can be *done* on a screen we are not authorised for:
    // the refusal arrives on the first action there rather than after it.
    //
    // The cost is one snapshot per non-navigating action. That is the price of
    // the interface staying at three methods; a cheaper `url()` would be a
    // fourth every decorator then has to forward correctly.
    //
    // The known limit: this reads the screen as it is *now*, so an action
    // issued while a click's navigation is still in flight can be judged
    // against the page being left rather than the one being arrived at. Every
    // ParaBank route a Recording clicks between is read-only, so it does not
    // bite here — but a flow that clicked straight from a read-only screen onto
    // a mutating one could have that first action judged against the wrong
    // page. Closing it needs a load barrier the Surface does not expose.
    const url = action.kind === "navigate" ? action.url : (await this.#inner.snapshot()).url;
    const verdict = routeOf(this.#profile, url);
    if (!verdict.allowed) return verdict.reason;

    if (verdict.mutates && !this.#mandate.mayMutate) {
      return `"${verdict.route}" can change data, and this run has no mandate to.`;
    }

    return undefined;
  }
}
