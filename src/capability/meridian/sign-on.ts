/**
 * The hand-written sign-on Capability: sign on as an operator and reach the
 * MERIDIAN main menu, or report that the credentials were turned back.
 *
 * Sign-on is primarily surface-level session establishment — `logInToMeridian`,
 * run ahead of every invoke — but it also exists as a recorded Capability for
 * §2.1 coverage, which is this. The two share one flow: this Recording is the
 * same six Actions `logInToMeridian` returns, carried as Steps so Replay can run
 * them and name how they ended.
 *
 * This module is the source; `capabilities/sign-on/1.json` is the artefact,
 * written by `npm run capability:write` and committed so a reviewer reads the
 * Capability as a file. A test fails if the two drift apart.
 *
 * Two deliberate departures from the design table in `docs/meridian-capabilities.md`:
 *
 * - `effects` is `read-only`, not a new `session` value. The field's only
 *   readers ask "may this be re-run from the start?" and "does replaying this
 *   need approval?"; signing on again is safe and needs no approval, so
 *   `read-only` is the honest answer to both, and no new enum value has to be
 *   threaded through the policy gate to say it.
 * - There is no `operatorRole` output. The banner it would come from ("Signed
 *   on as J. TELLER (TELLER)") is a bare `text:` node with no element behind it,
 *   so no single-control `read` can isolate the role. Reading it is
 *   `readOperatorRole`'s job at session-establishment time (ADR 0008), where a
 *   scan of the whole banner is the right tool. The Capability's outcome is the
 *   menu it reached, which is what success already is.
 */
import { z } from "zod";
import { jsonSchemaFor } from "../json-schema.js";
import { BASE_VARIANT, type Capability } from "../schema.js";
import { MERIDIAN_SIGN_ON_PATH } from "../../surface/meridian/login.js";

export const signOnInputs = z.object({
  operator: z.string().min(1).describe("The operator id, e.g. \"teller1\"."),
  /**
   * ADR 0006 classes this a Secret: supplied at run time, never written to any
   * artifact. It rides the same substitution every other input does, and the
   * evidence run masks it by value.
   */
  password: z.string().min(1).describe("The operator's password. A Secret — never persisted."),
  branch: z
    .enum(["MAIN-001 - Main Office", "WEST-014 - Westside", "EAST-022 - Eastgate"])
    .describe("The branch, as the sign-on combobox lists it."),
});

/**
 * No outputs. Success is reaching the menu; the operator role a caller might
 * want is read by session establishment, not extracted here — see the module
 * comment.
 */
export const signOnOutputs = z.object({});

export function signOnCapability(): Capability {
  return {
    id: "sign-on",
    version: 1,
    surface: "meridian",
    approval: "draft",
    contract: {
      summary: "Sign on as an operator and reach the MERIDIAN main menu.",
      inputs: jsonSchemaFor(signOnInputs),
      outputs: jsonSchemaFor(signOnOutputs),
      // Safe to re-run and needs no approval — see the module comment on why
      // this is `read-only` rather than a `session` value.
      effects: "read-only",
      terminalStates: [
        {
          // Signed on: standing on the main menu.
          kind: "success",
          when: {
            kind: "present",
            locator: { role: "heading", name: { kind: "literal", value: "MAIN MENU" } },
          },
        },
        {
          // Turned back: still on the sign-on screen after the attempt. Scoped
          // to that screen's own heading so it cannot match the menu, and read
          // only after a Step misses — a run that reached the menu never gets
          // here.
          kind: "business-outcome",
          name: "BAD_LOGIN",
          when: {
            kind: "present",
            locator: { role: "heading", name: { kind: "literal", value: "OPERATOR SIGN ON" } },
          },
        },
      ],
    },
    recordings: [
      {
        variant: BASE_VARIANT,
        steps: [
          {
            // A path, not a URL: the origin belongs to the Surface profile.
            id: "open-sign-on",
            action: { kind: "navigate", url: { kind: "literal", value: MERIDIAN_SIGN_ON_PATH } },
          },
          {
            // Unnamed inputs, reachable only by ordinal — the ADR 0001 case
            // MERIDIAN shares with ParaBank's login.
            id: "fill-operator",
            action: {
              kind: "fill",
              locator: { role: "textbox", ordinal: 0 },
              value: { kind: "input", input: "operator" },
            },
          },
          {
            id: "fill-password",
            action: {
              kind: "fill",
              locator: { role: "textbox", ordinal: 1 },
              value: { kind: "input", input: "password" },
            },
          },
          {
            id: "choose-branch",
            action: {
              kind: "select",
              locator: { role: "combobox", ordinal: 0 },
              option: { kind: "input", input: "branch" },
            },
          },
          {
            id: "sign-on",
            action: { kind: "click", locator: { role: "button", name: { kind: "literal", value: "Sign On" } } },
          },
          {
            id: "wait-for-menu",
            action: {
              kind: "waitFor",
              locator: { role: "heading", name: { kind: "literal", value: "MAIN MENU" } },
            },
          },
        ],
      },
    ],
  };
}
