/**
 * The hand-written open-share Capability: open a new share for a member,
 * walking MERIDIAN's form → review → post flow, and return the confirmation
 * number and new share id the opened share is given.
 *
 * It reaches the open-share form the same way funds-transfer and place-hold
 * reach theirs — the member-inquiry screen, searched by member number, followed
 * through "Select" to the record, then the record's "Open New Share" action link
 * — because a Recording cannot template a member number into a path (see
 * `substitute.ts`), so the number is carried by the search.
 *
 * The one negative outcome is the one MERIDIAN turns a bad request back with at
 * the review step: a deposit under the $5.00 minimum is refused. After
 * "Continue", a valid request reaches the "CONFIRM NEW SHARE" review and a
 * refused one reaches an "OPEN NEW SHARE" screen carrying the reason, so the
 * wait for the review heading misses and Replay reads it as the Business Outcome
 * `MINIMUM_DEPOSIT` — the validation failure named as an outcome the caller
 * acts on, not an error. This mirrors funds-transfer's review-step refusals.
 *
 * The hidden per-transaction token is never read: the browser's native form
 * submit carries it when "Open Share" is clicked (ADR 0001 holds unchanged).
 *
 * Written from the accessibility trees committed under
 * `evidence/accessibility-tree/meridian/` — the record and its "Open New Share"
 * link, the open-share form, the review, the opened confirmation, and the
 * minimum-deposit refusal — and every Locator is resolved against those trees in
 * `open-share.test.ts`.
 *
 * This module is the source; `capabilities/open-share/1.json` is the artefact,
 * written by `npm run capability:write` and committed so a reviewer reads the
 * Capability as a file. A test fails if the two drift apart.
 */
import { z } from "zod";
import { jsonSchemaFor } from "../json-schema.js";
import { BASE_VARIANT, type Capability, type StepLocator } from "../schema.js";

export const openShareInputs = z.object({
  memberNumber: z
    .string()
    .min(1)
    .describe(`The member's number, as the record shows it — for example "100234".`),
  shareType: z
    .enum([
      "S0001 - Regular Shares",
      "S0070 - Share Draft (Checking)",
      "MMKT - Money Market",
      "CERT - Certificate",
    ])
    .describe(`The type of share to open, exactly as the form's "Share Type" combobox lists it.`),
  initialDeposit: z
    .string()
    .min(1)
    .describe(
      `The opening deposit, as typed into the form — for example "5.00". ` +
        `MERIDIAN requires at least $5.00; a smaller amount is refused as MINIMUM_DEPOSIT.`,
    ),
});

export const openShareOutputs = z.object({
  /**
   * The confirmation number the opened share is given — for example "CN480249".
   * A read of one control's text, so it stays the displayed string.
   */
  confirmationNumber: z
    .string()
    .describe(`The opened share's confirmation number — for example "CN480249".`),
  /**
   * The id MERIDIAN assigned the new share — for example "100234-S0001-30".
   * Read from the confirmation screen, so it stays the displayed string.
   */
  newShareId: z
    .string()
    .describe(`The new share's id — for example "100234-S0001-30".`),
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
 * A value cell in the completion detail table on the opened screen, addressed by
 * the label its row carries. MERIDIAN prints each value in a two-cell row inside
 * that table, and wraps the whole screen in one outer cell whose accessible name
 * repeats every word on it — so `within` is pinned to the detail table (the
 * second table on the screen) to skip that outer cell, then the value is the
 * row's second cell. Resolved against the captured `open-share-complete` tree in
 * the test.
 */
function detailCell(label: string): StepLocator {
  return {
    role: "cell",
    ordinal: 1,
    within: {
      role: "row",
      name: { kind: "literal", value: label },
      within: { role: "table", ordinal: 1 },
    },
  };
}

/**
 * A validation refusal, addressed by the reason it carries. MERIDIAN renders the
 * reason as a bare list-item with no accessible name of its own, but the screen's
 * one content cell carries every word on the screen in its name — so the reason
 * is matched as a substring of that cell (the default, non-`exact`, match). The
 * reason is unique to the refusal, so this matches neither the review nor the form.
 */
function refusal(reason: string): StepLocator {
  return { role: "cell", name: { kind: "literal", value: reason } };
}

export function openShareCapability(): Capability {
  return {
    id: "open-share",
    version: 1,
    surface: "meridian",
    // Mutating, so approval is load-bearing (ADR 0007): this replays unattended
    // only once a human has signed it off. Draft as authored.
    approval: "draft",
    contract: {
      summary:
        "Open a new share for a member, walking form → review → post, and return the confirmation number and new share id.",
      inputs: jsonSchemaFor(openShareInputs),
      outputs: jsonSchemaFor(openShareOutputs),
      effects: "mutating",
      terminalStates: [
        {
          // The opened share's confirmation screen, reached through "Open Share".
          kind: "success",
          when: {
            kind: "present",
            locator: { role: "heading", name: { kind: "literal", value: "SHARE OPENED" }, exact: true },
          },
        },
        {
          // Deposit under the $5.00 minimum: the review step served the "OPEN NEW
          // SHARE" refusal screen instead of the "CONFIRM …" review, carrying
          // this reason. Scoped to the reason so it matches neither the form nor
          // the review.
          kind: "business-outcome",
          name: "MINIMUM_DEPOSIT",
          when: {
            kind: "present",
            locator: refusal("A minimum opening deposit of $5.00 is required."),
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
            // The record's action link, the only handle the open-share form has.
            id: "open-share-form",
            action: {
              kind: "click",
              locator: { role: "link", name: { kind: "literal", value: "Open New Share" }, exact: true },
            },
          },
          {
            id: "wait-for-form",
            action: {
              kind: "waitFor",
              locator: { role: "heading", name: { kind: "literal", value: "OPEN NEW SHARE" }, exact: true },
            },
          },
          {
            // The share type is the form's one combobox; the option is chosen by
            // its exact label, as the form lists it.
            id: "choose-share-type",
            action: {
              kind: "select",
              locator: { role: "combobox", ordinal: 0 },
              option: { kind: "input", input: "shareType" },
            },
          },
          {
            // The initial deposit is the form's one textbox.
            id: "fill-deposit",
            action: {
              kind: "fill",
              locator: { role: "textbox", ordinal: 0 },
              value: { kind: "input", input: "initialDeposit" },
            },
          },
          {
            id: "continue",
            action: { kind: "click", locator: { role: "button", name: { kind: "literal", value: "Continue" } } },
          },
          {
            // The branch point. A valid request reaches "CONFIRM NEW SHARE"; a
            // deposit under the minimum reaches an "OPEN NEW SHARE" refusal screen,
            // so this wait misses and Replay reads MINIMUM_DEPOSIT.
            id: "wait-for-review",
            action: {
              kind: "waitFor",
              locator: { role: "heading", name: { kind: "literal", value: "CONFIRM NEW SHARE" }, exact: true },
            },
          },
          {
            // The post. The hidden per-transaction token rides the native form
            // submit — it is never read here.
            id: "open-share",
            action: {
              kind: "click",
              locator: { role: "button", name: { kind: "literal", value: "Open Share" } },
            },
          },
          {
            id: "wait-for-opened",
            action: {
              kind: "waitFor",
              locator: { role: "heading", name: { kind: "literal", value: "SHARE OPENED" }, exact: true },
            },
          },
          {
            id: "read-confirmation",
            action: { kind: "read", locator: detailCell("Confirmation:"), bind: "confirmationNumber" },
          },
          {
            id: "read-share-id",
            action: { kind: "read", locator: detailCell("New Share ID:"), bind: "newShareId" },
          },
        ],
      },
    ],
  };
}
