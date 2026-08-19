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
 * Classification happens here rather than in the log because only this layer
 * knows where a value sat. What a `read` returned is Sensitive by position; a
 * Locator's accessible name is Plain by position and Sensitive only when this
 * run's own input was substituted into it; what a `fill` typed may be the
 * application password, which is a Secret and never written. ADR 0006's rule
 * that redaction is about what is stored and never about what is returned holds
 * literally here: `perform` hands the caller back the inner result untouched.
 */
import type { Action, ActionResult, Locator, Snapshot, Surface } from "../surface/surface.js";
import { redact, type Redaction } from "./redaction.js";
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
      ms,
      action: this.#loggedAction(action),
      result: this.#loggedResult(result),
    });

    // The screen the run could not interpret, captured at the Action that
    // missed rather than at the end — by then the run has moved on, and the
    // useful picture is of the state that stopped it.
    if (result.kind !== "ok") await this.#run.captureFailure(await this.#inner.screenshot());

    return result;
  }

  get #redaction(): Redaction {
    return this.#run.redaction;
  }

  #plain(text: string): string {
    return redact(this.#redaction, "plain", text);
  }

  #sensitive(text: string): string {
    return redact(this.#redaction, "sensitive", text);
  }

  #loggedAction(action: Action): Record<string, unknown> {
    switch (action.kind) {
      case "navigate":
        return { kind: action.kind, url: this.#plain(action.url) };
      case "fill":
        // What was typed. A password reaching here is a Secret and is stripped
        // whatever the setting says; anything else typed into an application
        // like this one is Sensitive.
        return {
          kind: action.kind,
          locator: this.#loggedLocator(action.locator),
          value: this.#sensitive(action.value),
        };
      case "select":
        return {
          kind: action.kind,
          locator: this.#loggedLocator(action.locator),
          option: this.#sensitive(action.option),
        };
      case "waitFor":
        return {
          kind: action.kind,
          locator: this.#loggedLocator(action.locator),
          ...(action.timeoutMs === undefined ? {} : { timeoutMs: action.timeoutMs }),
        };
      // Named rather than defaulted, so that an Action verb added later cannot
      // be logged by a catch-all that has no idea what its fields carry. This
      // switch is where ADR 0006 classifies a value, and a new verb arriving
      // unclassified is exactly the leak the classification exists to stop.
      case "click":
      case "read":
        return { kind: action.kind, locator: this.#loggedLocator(action.locator) };
    }
  }

  /**
   * A Locator's role and shape are Plain — they are the checked-in Recording,
   * readable in a diff. Its accessible name is Plain too right up until this
   * run substituted an account number into it, which is why the name goes
   * through the Plain path rather than round it: that path masks a known
   * Sensitive value found inside.
   */
  #loggedLocator(locator: Locator): Record<string, unknown> {
    return {
      role: locator.role,
      ...(locator.name === undefined ? {} : { name: this.#plain(locator.name) }),
      ...(locator.exact === undefined ? {} : { exact: locator.exact }),
      ...(locator.ordinal === undefined ? {} : { ordinal: locator.ordinal }),
      ...(locator.within === undefined ? {} : { within: this.#loggedLocator(locator.within) }),
    };
  }

  #loggedResult(result: ActionResult): Record<string, unknown> {
    switch (result.kind) {
      case "ok":
        // The one field on this path carrying a value off the screen, and the
        // reason the Capability exists. Masked here, returned in full above.
        return {
          kind: result.kind,
          ...(result.value === undefined ? {} : { value: this.#sensitive(result.value) }),
        };
      case "not-found":
        return { kind: result.kind, locator: this.#loggedLocator(result.locator) };
      case "ambiguous":
        return {
          kind: result.kind,
          locator: this.#loggedLocator(result.locator),
          matches: result.matches,
        };
      case "refused":
        return { kind: result.kind, reason: this.#plain(result.reason) };
    }
  }
}
