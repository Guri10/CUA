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
 * `PolicyGated(Evidence(Playwright | Fake))` — and ticket 8 slots its layer in
 * here, in one place, rather than at every call site.
 */
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
  options: PlaywrightSurfaceOptions = {},
): Promise<OpenSurface> {
  const browser = await PlaywrightSurface.launch(options);

  return {
    surface: new PolicyGatedSurface(browser, profile, mandate),
    close: () => browser.close(),
  };
}
