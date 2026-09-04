/**
 * Signing on to MERIDIAN Core, as a list of Actions.
 *
 * This mirrors `parabank/login.ts` exactly, and for the same reason: signing on
 * is a property of the installation rather than of any one Capability, so it
 * belongs to the Surface profile (`surfaces/meridian.json`) rather than to a
 * Recording. The day the sign-on screen gains a field, one description of the
 * application changes instead of every Capability that drives it.
 *
 * Its other job is to be the one interaction both implementations run: the
 * scripted fake in `login.test.ts`, and — once #30 lands — the real browser
 * against `web-sample.interface-hiring.com`.
 */
import type { Action } from "../surface.js";

/**
 * The path the sign-on screen is served at. The captured `menu`, `member`,
 * `transfer`, and `hold` trees all carry a clean `URL:` header, but the sign-on
 * capture does not — so this is the one address in the flow taken from the
 * application's own naming (`/menu`, `/members`, `/settings`, `/signoff`) rather
 * than from a header. #30 confirms it against the live target.
 */
export const MERIDIAN_SIGN_ON_PATH = "/signon";

export interface MeridianCredentials {
  /**
   * The operator id, e.g. `teller1`. Non-secret: the caller passes it, and it
   * is what the password is looked up by server-side (the design in
   * `docs/meridian-capabilities.md`).
   */
  readonly operator: string;
  /** ADR 0006 classes this a Secret: handed in at run time, never written. */
  readonly password: string;
  /**
   * The branch, as MERIDIAN lists it in the sign-on combobox — the whole
   * option label ("MAIN-001 - Main Office"), not the shorthand code. The option
   * is selected by its accessible name, and `optionLocator` matches that name
   * exactly, so the value has to be the label the target actually renders.
   */
  readonly branch: string;
}

export function logInToMeridian(baseUrl: string, credentials: MeridianCredentials): Action[] {
  return [
    { kind: "navigate", url: `${baseUrl}${MERIDIAN_SIGN_ON_PATH}` },

    // Both inputs are bare `- textbox` with no accessible name — the labels
    // "Operator ID:" and "Password:" sit in the sibling table cell, which
    // nothing associates with the field. Ordinal is the only handle the
    // accessibility vocabulary leaves, and ADR 0001 allows exactly that. It is
    // the same weakest-Locator case ParaBank's login exercises.
    { kind: "fill", locator: { role: "textbox", ordinal: 0 }, value: credentials.operator },
    { kind: "fill", locator: { role: "textbox", ordinal: 1 }, value: credentials.password },

    // One combobox on the screen, so ordinal 0 is the branch. Selected even
    // though MAIN-001 is the default, so a run signing on at a different branch
    // is not silently signed on at the wrong one.
    { kind: "select", locator: { role: "combobox", ordinal: 0 }, option: credentials.branch },

    { kind: "click", locator: { role: "button", name: "Sign On" } },

    // Arriving at the menu is what "signed on" means. The heading is the
    // stablest node on that screen — the "Signed on as …" banner underneath it
    // is a bare `text:` run with no element behind it, so it is not addressable
    // (see `readOperatorRole`).
    { kind: "waitFor", locator: { role: "heading", name: "MAIN MENU" } },
  ];
}

/**
 * The Operator's role, read off the post-login banner as the target's own
 * assertion (ADR 0008).
 *
 * The banner reads "Signed on as J. TELLER (TELLER)", and the role is the word
 * in the trailing parentheses. It is read here, from the whole snapshot, rather
 * than by a `read` Step in the sign-on Capability, because the banner is a bare
 * `text:` node folded into its parent cell's accessible name — there is no
 * addressable node that isolates it, so a single-control `read` cannot reach it.
 * Scanning the tree is the honest tool for a value the accessibility vocabulary
 * does not expose as a control.
 *
 * ADR 0008 makes this advisory, never a guarantee: `undefined` when the banner
 * is absent or shaped differently, for a caller to treat as "unknown" rather
 * than to build authority on.
 */
export function readOperatorRole(tree: string): string | undefined {
  // Whatever the target puts in the trailing parentheses, verbatim — not just
  // the uppercase `TELLER`/`SUPERVISOR` the captures show. ADR 0008 makes this
  // the target's own assertion, so a role shaped differently (mixed case, a
  // digit) is passed through rather than narrowed away to `unknown`.
  const match = /Signed on as[^()]*\(([^)]+)\)/.exec(tree);
  return match?.[1]?.trim();
}
