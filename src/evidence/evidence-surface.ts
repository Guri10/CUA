/**
 * The evidence trail, as a decorator over `Surface`.
 *
 * A decorator for the same reason the policy gate is one: logging somebody has
 * to remember to do is logging that will eventually be missing from one of the
 * two phases, and an audit trail with a gap in it is not an audit trail. This
 * sits inside the gate — the spec composes them as
 * `PolicyGated(Evidence(Playwright | Fake))` — so what it records is every
 * Action that was actually dispatched to a screen. An Action the gate refused
 * never reaches here, which is right for "a record of every action taken" and
 * is worth knowing when reading a log: a refusal is reported to the caller and
 * appears in the run's outcome, not as an Action in the log.
 *
 * Which field carries which kind of data is `classify-action.ts`, shared with
 * the escalation so that an Action a person took is masked by the same rules as
 * one the agent took. ADR 0006's rule that redaction is about what is stored and
 * never about what is returned holds literally here: `perform` hands the caller
 * back the inner result untouched.
 */
import type { Action, ActionResult, Snapshot, Surface } from "../surface/surface.js";
import { loggedAction, loggedResult } from "./classify-action.js";
import type { EvidenceRun } from "./run.js";

export class EvidenceSurface implements Surface {
  readonly #inner: Surface;
  readonly #run: EvidenceRun;

  constructor(inner: Surface, run: EvidenceRun) {
    this.#inner = inner;
    this.#run = run;
  }

  /**
   * Observing passes straight through, unlogged.
   *
   * Not an oversight: a snapshot is the whole accessibility tree, which on the
   * accounts overview is every account number and every balance the customer
   * holds. Writing one per Action would put more Sensitive data on disk than
   * the entire rest of the run, to record that the gate looked at the URL. The
   * screen is captured where it is actually needed — the failure screenshot.
   */
  async snapshot(): Promise<Snapshot> {
    return await this.#inner.snapshot();
  }

  async screenshot(): Promise<Buffer> {
    return await this.#inner.screenshot();
  }

  async perform(action: Action): Promise<ActionResult> {
    const seq = this.#run.nextSeq();
    const started = Date.now();
    const result = await this.#inner.perform(action);
    const ms = Date.now() - started;

    await this.#run.append({
      kind: "action",
      seq,
      // The agent, always. This decorator is only ever reached by something the
      // executor or the discovery loop performed — a person driving the same
      // session acts on the browser directly, and their Actions are captured
      // and written by the escalation. One trail, two authors, told apart here.
      by: "agent",
      ms,
      action: loggedAction(this.#run.redaction, action),
      result: loggedResult(this.#run.redaction, result),
    });

    // The screen an Action missed on, captured here rather than at the end — by
    // then the run has moved on, and the useful picture is of the state that
    // stopped it. What that state turns out to mean is decided above this
    // layer: since #6 a miss can be how a declared Business Outcome is
    // recognised, so the picture is named for the miss and the run's outcome
    // line says what the miss amounted to.
    if (result.kind !== "ok") await this.#run.captureFailure(await this.#inner.screenshot());

    return result;
  }
}
