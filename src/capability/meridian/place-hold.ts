/**
 * The hand-written place-hold Capability: place a hold on one of a member's
 * shares, walking MERIDIAN's form → review → post flow, and return the
 * confirmation number the recorded hold is given.
 *
 * It reaches the hold form the same way funds-transfer reaches the transfer
 * form — the member-inquiry screen, searched by member number, followed through
 * "Select" to the record, then the record's "Place Account Hold" action link —
 * because a Recording cannot template a member number into a path (see
 * `substitute.ts`), so the number is carried by the search.
 *
 * Placing a hold is a RESTRICTED FUNCTION. Authorization is the target's to
 * answer (ADR 0008): the Capability performs no role check of its own, it
 * attempts the hold and reports what MERIDIAN did. Under a supervisor session
 * "Continue" reaches the "CONFIRM ACCOUNT HOLD" review and "Apply Hold" posts
 * it; under a teller session "Continue" reaches a "supervisor override required"
 * screen instead, so the wait for the review heading misses and Replay reads it
 * as the Business Outcome `SUPERVISOR_OVERRIDE_REQUIRED` — the 403 named as an
 * outcome the caller acts on, not an error.
 *
 * The hidden per-transaction token is never read: the browser's native form
 * submit carries it when "Apply Hold" is clicked (ADR 0001 holds unchanged).
 *
 * Written from the accessibility trees committed under
 * `evidence/accessibility-tree/meridian/` — the record and its "Place Account
 * Hold" link, the hold form, the review, the applied confirmation, and the
 * override-required screen — and every Locator is resolved against those trees
 * in `place-hold.test.ts`.
 *
 * This module is the source; `capabilities/place-hold/1.json` is the artefact,
 * written by `npm run capability:write` and committed so a reviewer reads the
 * Capability as a file. A test fails if the two drift apart.
 */
import { z } from "zod";
import { jsonSchemaFor } from "../json-schema.js";
import { BASE_VARIANT, type Capability, type StepLocator } from "../schema.js";

export const placeHoldInputs = z.object({
  memberNumber: z
    .string()
    .min(1)
    .describe(`The member's number, as the record shows it — for example "100234".`),
  shareId: z
    .string()
    .min(1)
    .describe(
      `The share to hold, exactly as the hold form's "Share" combobox lists it — ` +
        `for example "100234-S0001 - Regular Shares".`,
    ),
  reasonCode: z
    .enum(["FRAUD - Suspected fraud", "LEGAL - Legal / levy", "DECEASED - Member deceased"])
    .describe(`The hold reason, as the "Reason Code" combobox lists it.`),
  notes: z
    .string()
    .default("")
    .describe(`Optional notes recorded with the hold; pass an empty string for none.`),
});

export const placeHoldOutputs = z.object({
  /**
   * The confirmation number the applied hold is given — for example "CN480245".
   * A read of one control's text, so it stays the displayed string.
   */
  confirmationNumber: z
    .string()
    .describe(`The applied hold's confirmation number — for example "CN480245".`),
});

/**
 * The results table's header cell on the inquiry screen — present once a search
 * has matched anything, absent when nothing matched. `exact`, so it addresses
 * the results header "Member No." and not the record's "Member No.:" label.
 */
function resultsHeader(): StepLocator {
  return { role: "cell", name: { kind: "literal", value: "Member No." }, exact: true };
}

/**
 * The confirmation number's value cell on the applied screen. MERIDIAN prints
 * the number in a two-cell "Confirmation: CN…" row inside the completion detail
 * table, and wraps the whole screen in one outer cell whose accessible name
 * repeats every word on it — so `within` is pinned to the detail table (the
 * second table on the screen) to skip that outer cell, then the value is the
 * row's second cell. Resolved against the captured `hold-complete` tree in the
 * test.
 */
function confirmationCell(): StepLocator {
  return {
    role: "cell",
    ordinal: 1,
    within: {
      role: "row",
      name: { kind: "literal", value: "Confirmation:" },
      within: { role: "table", ordinal: 1 },
    },
  };
}

export function placeHoldCapability(): Capability {
  return {
    id: "place-hold",
    version: 1,
    surface: "meridian",
    // Mutating, so approval is load-bearing (ADR 0007): this replays unattended
    // only once a human has signed it off. Draft as authored.
    approval: "draft",
    contract: {
      summary:
        "Place a hold on one of a member's shares, walking form → review → post, and return the confirmation number.",
      inputs: jsonSchemaFor(placeHoldInputs),
      outputs: jsonSchemaFor(placeHoldOutputs),
      effects: "mutating",
      terminalStates: [
        {
          // The applied hold's confirmation screen, reached through "Apply Hold".
          kind: "success",
          when: {
            kind: "present",
            locator: { role: "heading", name: { kind: "literal", value: "ACCOUNT HOLD APPLIED" }, exact: true },
          },
        },
        {
          // The 403: the review step served the override-required screen instead
          // of the "CONFIRM …" review. MERIDIAN renders the notice with no
          // heading of its own, but the screen's one content cell carries the
          // words in its name, so it is matched as a substring of that cell.
          kind: "business-outcome",
          name: "SUPERVISOR_OVERRIDE_REQUIRED",
          when: {
            kind: "present",
            locator: { role: "cell", name: { kind: "literal", value: "SUPERVISOR OVERRIDE REQUIRED" } },
          },
        },
      ],
    },
    recordings: [
      {
        variant: BASE_VARIANT,
        steps: [
          {
            id: "open-inquiry",
            action: { kind: "navigate", url: { kind: "literal", value: "/members" } },
          },
          {
            id: "choose-search-by",
            action: {
              kind: "select",
              locator: { role: "combobox", ordinal: 0 },
              option: { kind: "literal", value: "Member Number" },
            },
          },
          {
            id: "fill-member-number",
            action: {
              kind: "fill",
              locator: { role: "textbox", ordinal: 0 },
              value: { kind: "input", input: "memberNumber" },
            },
          },
          {
            id: "run-search",
            action: { kind: "click", locator: { role: "button", name: { kind: "literal", value: "Search" } } },
          },
          {
            id: "wait-for-results",
            action: { kind: "waitFor", locator: resultsHeader() },
          },
          {
            id: "select-member",
            action: {
              kind: "click",
              locator: { role: "link", name: { kind: "literal", value: "Select" }, exact: true },
            },
          },
          {
            id: "wait-for-record",
            action: {
              kind: "waitFor",
              locator: { role: "heading", name: { kind: "literal", value: "MEMBER RECORD" }, exact: true },
            },
          },
          {
            // The record's action link, the only handle the hold form has.
            id: "open-hold",
            action: {
              kind: "click",
              locator: { role: "link", name: { kind: "literal", value: "Place Account Hold" }, exact: true },
            },
          },
          {
            id: "wait-for-form",
            action: {
              kind: "waitFor",
              locator: { role: "heading", name: { kind: "literal", value: "PLACE ACCOUNT HOLD" }, exact: true },
            },
          },
          {
            // Share and Reason are the two comboboxes in order; the option is
            // chosen by its exact label, as the form lists it.
            id: "choose-share",
            action: {
              kind: "select",
              locator: { role: "combobox", ordinal: 0 },
              option: { kind: "input", input: "shareId" },
            },
          },
          {
            id: "choose-reason",
            action: {
              kind: "select",
              locator: { role: "combobox", ordinal: 1 },
              option: { kind: "input", input: "reasonCode" },
            },
          },
          {
            // The hold form's one textbox.
            id: "fill-notes",
            action: {
              kind: "fill",
              locator: { role: "textbox", ordinal: 0 },
              value: { kind: "input", input: "notes" },
            },
          },
          {
            id: "continue",
            action: { kind: "click", locator: { role: "button", name: { kind: "literal", value: "Continue" } } },
          },
          {
            // The branch point. A supervisor reaches "CONFIRM ACCOUNT HOLD"; a
            // teller reaches the override-required screen, so this wait misses
            // and Replay reads the 403 as SUPERVISOR_OVERRIDE_REQUIRED.
            id: "wait-for-review",
            action: {
              kind: "waitFor",
              locator: {
                role: "heading",
                name: { kind: "literal", value: "CONFIRM ACCOUNT HOLD" },
                exact: true,
              },
            },
          },
          {
            // The post. The hidden per-transaction token rides the native form
            // submit — it is never read here.
            id: "apply",
            action: {
              kind: "click",
              locator: { role: "button", name: { kind: "literal", value: "Apply Hold" } },
            },
          },
          {
            id: "wait-for-applied",
            action: {
              kind: "waitFor",
              locator: { role: "heading", name: { kind: "literal", value: "ACCOUNT HOLD APPLIED" }, exact: true },
            },
          },
          {
            id: "read-confirmation",
            action: { kind: "read", locator: confirmationCell(), bind: "confirmationNumber" },
          },
        ],
      },
    ],
  };
}
