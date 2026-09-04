/**
 * The hand-written funds-transfer Capability: move an amount from one of a
 * member's shares to another, walking MERIDIAN's form → review → post flow, and
 * return the confirmation number the posted transfer is given.
 *
 * It reaches the transfer form the same way member-balance reaches the record —
 * the member-inquiry screen, searched by member number, followed through
 * "Select" to the record, then the record's "Funds Transfer" action link —
 * rather than by navigating straight to `/members/<n>/transfer`. A Recording
 * stores a path as a literal or an input reference and cannot template a member
 * number into one (see `substitute.ts`), so the number is carried by the search
 * the flow already knows how to parameterise, exactly as member-balance does.
 *
 * The two negative outcomes are the ones MERIDIAN actually turns a bad request
 * back with, each a predicate over the screen it served: debiting a share on
 * HOLD is refused (`SOURCE_ON_HOLD`), and an amount over the source balance is
 * refused (`INSUFFICIENT_FUNDS`). Both are recognised at the review step: after
 * "Continue", a valid request reaches the "CONFIRM FUNDS TRANSFER" review and a
 * refused one reaches a "FUNDS TRANSFER" screen carrying the reason, so the wait
 * for the review heading misses and Replay reads which refusal it was from the
 * validation list-item on display.
 *
 * The hidden per-transaction token is never read: the browser's native form
 * submit carries it when "Post Transfer" is clicked (ADR 0001 holds unchanged).
 *
 * Written from the accessibility trees committed under
 * `evidence/accessibility-tree/meridian/` — the record and its "Funds Transfer"
 * link, the transfer form, the review, the posted confirmation, and the two
 * refusal screens — and every Locator is resolved against those trees in
 * `funds-transfer.test.ts`.
 *
 * This module is the source; `capabilities/funds-transfer/1.json` is the
 * artefact, written by `npm run capability:write` and committed so a reviewer
 * reads the Capability as a file. A test fails if the two drift apart.
 */
import { z } from "zod";
import { jsonSchemaFor } from "../json-schema.js";
import { BASE_VARIANT, type Capability, type StepLocator } from "../schema.js";

export const fundsTransferInputs = z.object({
  memberNumber: z
    .string()
    .min(1)
    .describe(`The member's number, as the record shows it — for example "100234".`),
  fromShare: z
    .string()
    .min(1)
    .describe(
      `The share to debit, exactly as the transfer form's "From Share" combobox lists it — ` +
        `for example "100234-S0001-14 - Regular Shares ($100.00)".`,
    ),
  toShare: z
    .string()
    .min(1)
    .describe(`The share to credit, exactly as the "To Share" combobox lists it.`),
  amount: z
    .string()
    .min(1)
    .describe(`The amount to transfer, as typed into the form — for example "1.00".`),
  memo: z
    .string()
    .default("")
    .describe(`An optional memo recorded with the transfer; pass an empty string for none.`),
});

export const fundsTransferOutputs = z.object({
  /**
   * The confirmation number the posted transfer is given — for example
   * "CN480242". A read of one control's text, so it stays the displayed string.
   */
  confirmationNumber: z
    .string()
    .describe(`The posted transfer's confirmation number — for example "CN480242".`),
});

/**
 * The results table's header cell on the inquiry screen — present once a search
 * has matched anything, absent when nothing matched. `exact`, so it addresses
 * the results header "Member No." and not the record's "Member No.:" label,
 * which carries it as a prefix. The same Locator member-balance searches by.
 */
function resultsHeader(): StepLocator {
  return { role: "cell", name: { kind: "literal", value: "Member No." }, exact: true };
}

/**
 * The confirmation number's value cell on the posted screen. MERIDIAN prints
 * the number in a two-cell "Confirmation: CN…" row inside the completion detail
 * table, and wraps the whole screen in one outer cell whose accessible name
 * repeats every word on it — so `within` is pinned to the detail table (the
 * second table on the screen) to skip that outer cell, then the value is the
 * row's second cell. Resolved against the captured `transfer-complete` tree in
 * the test.
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

/**
 * A validation refusal, addressed by the reason it carries. MERIDIAN renders the
 * reason as a bare list-item with no accessible name of its own, but the screen's
 * one content cell carries every word on the screen in its name — so the reason
 * is matched as a substring of that cell (the default, non-`exact`, match). Each
 * reason is unique to its screen, so this addresses one refusal and not the other,
 * and matches neither the review nor the form.
 */
function refusal(reason: string): StepLocator {
  return { role: "cell", name: { kind: "literal", value: reason } };
}

export function fundsTransferCapability(): Capability {
  return {
    id: "funds-transfer",
    version: 1,
    surface: "meridian",
    // Mutating, so approval is load-bearing (ADR 0007): this replays unattended
    // only once a human has signed it off. Draft as authored — the recorder
    // cannot approve its own work by omission.
    approval: "draft",
    contract: {
      summary:
        "Transfer an amount between two of a member's shares, walking form → review → post, and return the confirmation number.",
      inputs: jsonSchemaFor(fundsTransferInputs),
      outputs: jsonSchemaFor(fundsTransferOutputs),
      effects: "mutating",
      terminalStates: [
        {
          // The posted transfer's confirmation screen, reached through "Post
          // Transfer".
          kind: "success",
          when: {
            kind: "present",
            locator: { role: "heading", name: { kind: "literal", value: "TRANSFER POSTED" }, exact: true },
          },
        },
        {
          // Source share on HOLD: the review step served the "FUNDS TRANSFER"
          // refusal screen instead of the "CONFIRM …" review, carrying this
          // reason. Scoped to the reason's own list-item so it cannot match the
          // insufficient-funds refusal, which carries a different one.
          kind: "business-outcome",
          name: "SOURCE_ON_HOLD",
          when: { kind: "present", locator: refusal("Source share is HOLD and cannot be debited.") },
        },
        {
          // Amount over the source balance: the other refusal the review step
          // can serve.
          kind: "business-outcome",
          name: "INSUFFICIENT_FUNDS",
          when: {
            kind: "present",
            locator: refusal("Insufficient available balance in the source share."),
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
            // A miss here is no results table — no such member — read before the
            // "Select" click so a genuine miss is not mistaken for an unfound link.
            id: "wait-for-results",
            action: { kind: "waitFor", locator: resultsHeader() },
          },
          {
            // A member number is unique, so there is exactly one "Select".
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
            // The record's action link, the only handle the transfer form has.
            id: "open-transfer",
            action: {
              kind: "click",
              locator: { role: "link", name: { kind: "literal", value: "Funds Transfer" }, exact: true },
            },
          },
          {
            id: "wait-for-form",
            action: {
              kind: "waitFor",
              locator: { role: "heading", name: { kind: "literal", value: "FUNDS TRANSFER" }, exact: true },
            },
          },
          {
            // From and To are the two comboboxes in order; the option is chosen
            // by its exact label, as the form lists it.
            id: "choose-from",
            action: {
              kind: "select",
              locator: { role: "combobox", ordinal: 0 },
              option: { kind: "input", input: "fromShare" },
            },
          },
          {
            id: "choose-to",
            action: {
              kind: "select",
              locator: { role: "combobox", ordinal: 1 },
              option: { kind: "input", input: "toShare" },
            },
          },
          {
            // Amount and Memo are the two textboxes in order.
            id: "fill-amount",
            action: {
              kind: "fill",
              locator: { role: "textbox", ordinal: 0 },
              value: { kind: "input", input: "amount" },
            },
          },
          {
            id: "fill-memo",
            action: {
              kind: "fill",
              locator: { role: "textbox", ordinal: 1 },
              value: { kind: "input", input: "memo" },
            },
          },
          {
            id: "continue",
            action: { kind: "click", locator: { role: "button", name: { kind: "literal", value: "Continue" } } },
          },
          {
            // The branch point. A valid request reaches "CONFIRM FUNDS TRANSFER";
            // a refused one reaches a "FUNDS TRANSFER" screen with the reason, so
            // this wait misses and Replay reads the refusal as a Business Outcome.
            id: "wait-for-review",
            action: {
              kind: "waitFor",
              locator: {
                role: "heading",
                name: { kind: "literal", value: "CONFIRM FUNDS TRANSFER" },
                exact: true,
              },
            },
          },
          {
            // The post. The hidden per-transaction token rides the native form
            // submit — it is never read here.
            id: "post",
            action: {
              kind: "click",
              locator: { role: "button", name: { kind: "literal", value: "Post Transfer" } },
            },
          },
          {
            id: "wait-for-posted",
            action: {
              kind: "waitFor",
              locator: { role: "heading", name: { kind: "literal", value: "TRANSFER POSTED" }, exact: true },
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
