/**
 * The hand-written update-member Capability: update a member's contact
 * information — e-mail, phone, and mailing address — in a single step. Unlike
 * open-share and the transfer/hold flows, there is no review screen: "Save
 * Changes" either lands on the "MEMBER INFORMATION UPDATED" confirmation or is
 * turned back to the form with a validation message, so this Capability has no
 * form → review → post walk, only form → post.
 *
 * It reaches the update form the same way the other member actions reach theirs
 * — the member-inquiry screen, searched by member number, followed through
 * "Select" to the record, then the record's "Update Member Information" action
 * link — because a Recording cannot template a member number into a path (see
 * `substitute.ts`), so the number is carried by the search.
 *
 * The two negative outcomes are the ones MERIDIAN turns a bad request back with,
 * each a predicate over the screen it served: an e-mail not in a valid format is
 * refused (`INVALID_EMAIL`) and a phone number that is not valid is refused
 * (`INVALID_PHONE`). Both are recognised after "Save Changes": a valid request
 * reaches the "MEMBER INFORMATION UPDATED" confirmation and a refused one is left
 * on the "UPDATE MEMBER INFORMATION" screen carrying the reason, so the wait for
 * the confirmation heading misses and Replay reads which refusal it was from the
 * validation list-item on display.
 *
 * The confirmation screen carries no id of its own — it says only that the change
 * was saved — so the Capability reads nothing and its outputs are empty; success
 * is the confirmation heading, exactly as sign-on's success is the menu it reached.
 *
 * The hidden per-transaction token is never read: the browser's native form
 * submit carries it when "Save Changes" is clicked (ADR 0001 holds unchanged).
 *
 * Written from the accessibility trees committed under
 * `evidence/accessibility-tree/meridian/` — the record and its "Update Member
 * Information" link, the update form, the saved confirmation, and the two
 * validation refusals — and every Locator is resolved against those trees in
 * `update-member.test.ts`.
 *
 * This module is the source; `capabilities/update-member/1.json` is the
 * artefact, written by `npm run capability:write` and committed so a reviewer
 * reads the Capability as a file. A test fails if the two drift apart.
 */
import { z } from "zod";
import { jsonSchemaFor } from "../json-schema.js";
import { BASE_VARIANT, type Capability, type StepLocator } from "../schema.js";

export const updateMemberInputs = z.object({
  memberNumber: z
    .string()
    .min(1)
    .describe(`The member's number, as the record shows it — for example "100234".`),
  email: z
    .string()
    .min(1)
    .describe(
      `The member's e-mail address, as typed into the form — for example ` +
        `"ada@example.com". An address not in a valid format is refused as INVALID_EMAIL.`,
    ),
  phone: z
    .string()
    .min(1)
    .describe(
      `The member's phone number, as typed into the form — for example "555-0155". ` +
        `A number that is not valid is refused as INVALID_PHONE.`,
    ),
  mailingAddress: z
    .string()
    .min(1)
    .describe(`The member's mailing address, as typed into the form.`),
});

/**
 * The confirmation screen carries no confirmation number or id — it states only
 * that the change was saved — so there is nothing to read and outputs are empty.
 * Success is proven by the terminal state, as it is for sign-on.
 */
export const updateMemberOutputs = z.object({});

/**
 * The results table's header cell on the inquiry screen — present once a search
 * has matched anything, absent when nothing matched. `exact`, so it addresses
 * the results header "Member No." and not the record's "Member No.:" label.
 */
function resultsHeader(): StepLocator {
  return { role: "cell", name: { kind: "literal", value: "Member No." }, exact: true };
}

/**
 * A validation refusal, addressed by the reason it carries. MERIDIAN renders the
 * reason as a bare list-item with no accessible name of its own, but the screen's
 * one content cell carries every word on the screen in its name — so the reason
 * is matched as a substring of that cell (the default, non-`exact`, match). Each
 * reason is unique to its screen, so this addresses one refusal and not the other,
 * and matches neither the form nor the saved confirmation.
 */
function refusal(reason: string): StepLocator {
  return { role: "cell", name: { kind: "literal", value: reason } };
}

export function updateMemberCapability(): Capability {
  return {
    id: "update-member",
    version: 1,
    surface: "meridian",
    // Mutating, so approval is load-bearing (ADR 0007): this replays unattended
    // only once a human has signed it off. Draft as authored.
    approval: "draft",
    contract: {
      summary:
        "Update a member's e-mail, phone, and mailing address in a single step, and confirm the change was saved.",
      inputs: jsonSchemaFor(updateMemberInputs),
      outputs: jsonSchemaFor(updateMemberOutputs),
      effects: "mutating",
      terminalStates: [
        {
          // The saved confirmation, reached through "Save Changes". Its heading
          // ("MEMBER INFORMATION UPDATED") is distinct from the form's and the
          // refusals' ("UPDATE MEMBER INFORMATION"), so `exact` isolates it.
          kind: "success",
          when: {
            kind: "present",
            locator: {
              role: "heading",
              name: { kind: "literal", value: "MEMBER INFORMATION UPDATED" },
              exact: true,
            },
          },
        },
        {
          // E-mail not in a valid format: Save Changes was refused and left the
          // run on the "UPDATE MEMBER INFORMATION" screen with this reason.
          kind: "business-outcome",
          name: "INVALID_EMAIL",
          when: { kind: "present", locator: refusal("E-mail address is not in a valid format.") },
        },
        {
          // Phone not valid: the other refusal Save Changes can serve.
          kind: "business-outcome",
          name: "INVALID_PHONE",
          when: { kind: "present", locator: refusal("Phone number is not valid.") },
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
            // The record's action link, the only handle the update form has.
            id: "open-update-form",
            action: {
              kind: "click",
              locator: {
                role: "link",
                name: { kind: "literal", value: "Update Member Information" },
                exact: true,
              },
            },
          },
          {
            id: "wait-for-form",
            action: {
              kind: "waitFor",
              locator: {
                role: "heading",
                name: { kind: "literal", value: "UPDATE MEMBER INFORMATION" },
                exact: true,
              },
            },
          },
          {
            // E-mail, Phone, and Mailing Address are the three textboxes in order.
            id: "fill-email",
            action: {
              kind: "fill",
              locator: { role: "textbox", ordinal: 0 },
              value: { kind: "input", input: "email" },
            },
          },
          {
            id: "fill-phone",
            action: {
              kind: "fill",
              locator: { role: "textbox", ordinal: 1 },
              value: { kind: "input", input: "phone" },
            },
          },
          {
            id: "fill-address",
            action: {
              kind: "fill",
              locator: { role: "textbox", ordinal: 2 },
              value: { kind: "input", input: "mailingAddress" },
            },
          },
          {
            // The post. No review — this is the single mutating step. The hidden
            // per-transaction token rides the native form submit.
            id: "save",
            action: {
              kind: "click",
              locator: { role: "button", name: { kind: "literal", value: "Save Changes" } },
            },
          },
          {
            // The branch point. A valid request reaches "MEMBER INFORMATION
            // UPDATED"; a refused one stays on the form with the reason, so this
            // wait misses and Replay reads INVALID_EMAIL or INVALID_PHONE.
            id: "wait-for-saved",
            action: {
              kind: "waitFor",
              locator: {
                role: "heading",
                name: { kind: "literal", value: "MEMBER INFORMATION UPDATED" },
                exact: true,
              },
            },
          },
        ],
      },
    ],
  };
}
