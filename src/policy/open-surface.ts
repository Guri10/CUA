/**
 * The only way to get a Surface to drive.
 *
 * Both phases call this and both get something already wrapped, so ADR 0007's
 * "one gate, both phases" is a property of the code rather than a rule people
 * follow. `no-ungated-surface.test.ts` is what keeps it that way: nothing
 * outside `src/surface/` and this module may name a Surface implementation or
 * reach for the browser directly.
 *
 * The decorators compose as the spec describes them —
 * `PolicyGated(Evidence(Playwright | Fake))` — in one place rather than at
 * every call site.
 *
 * The evidence run is a required argument rather than an option, which is what
 * makes "nothing touches the screen without being logged" the same kind of
 * guarantee as "nothing touches the screen without being gated": there is no
 * call to this that omits it, and `no-ungated-surface.test.ts` forbids reaching
 * past it for an unwrapped one.
 */
import { SessionControl } from "../escalation/controller.js";
import { ControllerGatedSurface } from "../escalation/controller-gated-surface.js";
import { EvidenceSurface } from "../evidence/evidence-surface.js";
import type { EvidenceRun } from "../evidence/run.js";
import { PlaywrightSurface, type PlaywrightSurfaceOptions } from "../surface/playwright-surface.js";
import type { StopCapture } from "../surface/human-actions.js";
import type { Action, Surface } from "../surface/surface.js";
import { PolicyGatedSurface, type PolicyMandate } from "./policy-gated-surface.js";
import type { SurfaceProfile } from "./profile.js";

export interface OpenSurface {
  readonly surface: Surface;
  /**
   * Who holds the right to act on this session. Handed out rather than hidden
   * because the escalation has to move it and the gate above has to read it,
   * and two of these would be two answers to "may the agent act right now".
   */
  readonly control: SessionControl;
  /**
   * Records what a person does to this session while they hold it, in the
   * Action vocabulary. Passed straight to `handOverToHuman`, which is the only
   * caller: the escalation does not know it is driving a browser, and this is
   * where that stays true.
   */
  capture(onAction: (action: Action) => void): Promise<StopCapture>;
  close(): Promise<void>;
}

/**
 * A real browser, gated. The caller gets `Surface` and not the implementation,
 * so there is nothing to unwrap even by accident.
 */
export async function openBrowserSurface(
  profile: SurfaceProfile,
  mandate: PolicyMandate,
  evidence: EvidenceRun,
  options: PlaywrightSurfaceOptions = {},
): Promise<OpenSurface> {
  const browser = await PlaywrightSurface.launch(options);
  const control = new SessionControl();

  return {
    // Controller outside, gate next, evidence inside. The gate refuses before
    // dispatch, so the log records what was done to the application rather than
    // what was asked for — a refusal is the caller's answer and the run's
    // outcome, not an Action that happened. The Controller sits outside even
    // that: while a person holds the session there is nothing to gate and
    // nothing to log, and an agent action recorded at a moment the trail says
    // the human was driving is the one thing an audit trail must not contain.
    surface: new ControllerGatedSurface(
      new PolicyGatedSurface(new EvidenceSurface(browser, evidence), profile, mandate),
      control,
    ),
    control,
    capture: (onAction) => browser.captureHumanActions(onAction),
    close: () => browser.close(),
  };
}
