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
import { EvidenceSurface } from "../evidence/evidence-surface.js";
import type { EvidenceRun } from "../evidence/run.js";
import { PlaywrightSurface, type PlaywrightSurfaceOptions } from "../surface/playwright-surface.js";
import type { Surface } from "../surface/surface.js";
import { PolicyGatedSurface, type PolicyMandate } from "./policy-gated-surface.js";
import type { SurfaceProfile } from "./profile.js";

export interface OpenSurface {
  readonly surface: Surface;
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

  return {
    // Gate outside, evidence inside. The gate refuses before dispatch, so the
    // log records what was done to the application rather than what was asked
    // for — a refusal is the caller's answer and the run's outcome, not an
    // Action that happened.
    surface: new PolicyGatedSurface(new EvidenceSurface(browser, evidence), profile, mandate),
    close: () => browser.close(),
  };
}
