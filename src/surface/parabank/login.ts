/**
 * Logging in to ParaBank, as a list of Actions.
 *
 * This is not a Recording and these are not Steps. Login is a property of the
 * application rather than of any one Capability — the day ParaBank's form gains
 * a field, one description of the application changes instead of every
 * Recording — so it belongs to the Surface profile that ticket 7 builds, and
 * ADR 0005 puts Recoverable Conditions at that same scope for the same reason.
 * Login-at-the-start and session-expiry-mid-run are the same event: the
 * application is showing its login screen instead of what was asked for.
 *
 * The seam is built so that this can exist at all. `perform` takes an Action
 * from wherever, so nothing here has to pretend to originate from a Step.
 *
 * Its other job is to be the one interaction both implementations run: the
 * real browser in `login.e2e.test.ts`, the scripted fake in `login.test.ts`.
 */
import type { Action } from "../surface.js";

export interface ParabankCredentials {
  readonly username: string;
  /** ADR 0006 classes this a Secret: handed in at run time, never written. */
  readonly password: string;
}

export function logInToParabank(baseUrl: string, credentials: ParabankCredentials): Action[] {
  return [
    { kind: "navigate", url: `${baseUrl}/index.htm` },

    // Both inputs are bare `- textbox` with no accessible name — the words
    // "Username" and "Password" sit in sibling paragraphs that nothing
    // associates with the fields. Ordinal is the only handle the accessibility
    // vocabulary leaves, and ADR 0001 allows exactly that. It is also the
    // weakest Locator in the system, which is why running this same list
    // against both implementations is worth doing.
    { kind: "fill", locator: { role: "textbox", ordinal: 0 }, value: credentials.username },
    { kind: "fill", locator: { role: "textbox", ordinal: 1 }, value: credentials.password },

    { kind: "click", locator: { role: "button", name: "Log In" } },
    { kind: "waitFor", locator: { role: "heading", name: "Accounts Overview" } },

    // Arriving at the overview is not the same as the overview being readable.
    // Every table in this application renders its structure immediately and
    // fills it from a request that finishes later, so a heading match passes
    // on a screen whose account rows have not arrived. Waiting for a row whose
    // accessible name carries an amount is the accessibility-vocabulary way to
    // know the screen has settled; the ordinal asks for one such row rather
    // than all eleven.
    { kind: "waitFor", locator: { role: "row", name: "$", ordinal: 0 } },
  ];
}
