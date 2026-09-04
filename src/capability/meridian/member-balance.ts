/**
 * The hand-written member-balance Capability: given a member number, return
 * every share on that member's record — its id, type, balance, and status — as
 * a list, and name the one negative outcome (no such member) as a Business
 * Outcome the caller acts on.
 *
 * It reaches the record the same way member-lookup does — the member-inquiry
 * screen, searched by member number, followed through "Select" — rather than by
 * navigating straight to `/members/<n>`. The search flow is the one MERIDIAN
 * actually served a not-found screen for, so `NOT_FOUND` is a predicate over a
 * captured tree rather than a guess about a URL we never recorded. Because a
 * member number is unique there is never more than one candidate, so this
 * Capability declares no `MULTIPLE_MATCHES` — that outcome belongs to
 * member-lookup's by-name search, not here.
 *
 * The shares themselves are read with one `readEach` Step (ADR 0010): the row
 * Locator matches every share row, and each column is resolved *within its own
 * row*, so the balances — which repeat across rows ("$25.00" appears three
 * times on the captured member) — are never ambiguous. A member with no shares
 * reads as the empty list, not a miss.
 *
 * Written from the accessibility trees committed under
 * `evidence/accessibility-tree/meridian/` — the member-inquiry form and the
 * `member-100234` record its shares table lives on — and every Locator is
 * resolved against those trees in `member-balance.test.ts`.
 *
 * This module is the source; `capabilities/member-balance/1.json` is the
 * artefact, written by `npm run capability:write` and committed so a reviewer
 * reads the Capability as a file. A test fails if the two drift apart.
 */
import { z } from "zod";
import { jsonSchemaFor } from "../json-schema.js";
import { BASE_VARIANT, type Capability, type StepLocator } from "../schema.js";

export const memberBalanceInputs = z.object({
  memberNumber: z
    .string()
    .min(1)
    .describe(`The member's number, as the record shows it — for example "100234".`),
});

export const memberBalanceOutputs = z.object({
  /**
   * Every share on the record, in the order the screen lists them. ADR 0006
   * classes a member's balances Sensitive: returned to the caller in full,
   * masked in persisted evidence. Each field stays the displayed string — the
   * balance is "$2,499.00", not a number — so the caller sees what an operator
   * would see and no currency or sign convention is silently invented here.
   */
  shares: z
    .array(
      z.object({
        shareId: z.string().describe(`The share's id — for example "100234-S0001".`),
        type: z.string().describe(`The share's type, as displayed — for example "Regular Shares".`),
        balance: z.string().describe(`The share's balance, as displayed — for example "$2,499.00".`),
        status: z.string().describe(`The share's status, as displayed — for example "OPEN" or "HOLD [HOLD]".`),
      }),
    )
    .describe("Every share on the member record, id / type / balance / status, in screen order."),
});

/**
 * The results table's header cell on the inquiry screen, present once a search
 * has matched anything and absent when nothing matched — the whole difference
 * between reaching a record and `NOT_FOUND`. `exact`, so it addresses the
 * results header "Member No." and not the record screen's "Member No.:" label,
 * which carries it as a prefix.
 */
function resultsHeader(): StepLocator {
  return { role: "cell", name: { kind: "literal", value: "Member No." }, exact: true };
}

/**
 * One share row of the SHARES / BALANCES table. Every share row's accessible
 * name carries a "$" balance; the column-header row ("Share ID Type Balance
 * Status") and the identity rows above the table do not, so this matches the
 * share rows and nothing else — for any member, without counting them.
 */
function shareRow(): StepLocator {
  return { role: "row", name: { kind: "literal", value: "$" } };
}

export function memberBalanceCapability(): Capability {
  return {
    id: "member-balance",
    version: 1,
    surface: "meridian",
    // Read-only, so approval decides nothing here — stated rather than defaulted
    // so a reviewer reading the file need not know what the schema fills in.
    approval: "draft",
    contract: {
      summary: "Read every share on a member's record — id, type, balance, and status — by member number.",
      inputs: jsonSchemaFor(memberBalanceInputs),
      outputs: jsonSchemaFor(memberBalanceOutputs),
      effects: "read-only",
      terminalStates: [
        {
          // The member record, reached through "Select".
          kind: "success",
          when: {
            kind: "present",
            locator: { role: "heading", name: { kind: "literal", value: "MEMBER RECORD" }, exact: true },
          },
        },
        {
          // No such member: standing on the inquiry screen with no results
          // table. Scoped to that screen's own heading so it cannot match the
          // record, and requiring the results header to be absent so it cannot
          // match a screen that did find someone.
          kind: "business-outcome",
          name: "NOT_FOUND",
          when: {
            kind: "all",
            of: [
              {
                kind: "present",
                locator: {
                  role: "heading",
                  name: { kind: "literal", value: "MEMBER INQUIRY / SELECTION" },
                  exact: true,
                },
              },
              { kind: "absent", locator: resultsHeader() },
            ],
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
            // Search by member number: the combobox option is MERIDIAN's own
            // label, the same one member-lookup selects by accessible name.
            id: "choose-search-by",
            action: {
              kind: "select",
              locator: { role: "combobox", ordinal: 0 },
              option: { kind: "literal", value: "Member Number" },
            },
          },
          {
            // One unnamed textbox — the value field, reachable only by ordinal.
            id: "fill-value",
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
            // Missing here means no results table arrived — no such member. Read
            // before the "Select" click so a genuine miss becomes NOT_FOUND
            // rather than an unfound link.
            id: "wait-for-results",
            action: { kind: "waitFor", locator: resultsHeader() },
          },
          {
            // A member number is unique, so there is exactly one "Select" and the
            // click resolves and leads on to the record.
            id: "select-member",
            action: { kind: "click", locator: { role: "link", name: { kind: "literal", value: "Select" }, exact: true } },
          },
          {
            // Singular on purpose: the bare share-row Locator matches all of them,
            // which a waitFor reads as ambiguous. Waiting on the record heading
            // is the singular checkpoint, and it holds even for a member with no
            // shares — whose readEach then reads the empty list.
            id: "wait-for-record",
            action: {
              kind: "waitFor",
              locator: { role: "heading", name: { kind: "literal", value: "MEMBER RECORD" }, exact: true },
            },
          },
          {
            // Each column is resolved within its own row, so the balance — which
            // repeats across rows — is read unambiguously per share.
            id: "read-shares",
            action: {
              kind: "readEach",
              rows: shareRow(),
              columns: {
                shareId: { role: "cell", ordinal: 0 },
                type: { role: "cell", ordinal: 1 },
                balance: { role: "cell", ordinal: 2 },
                status: { role: "cell", ordinal: 3 },
              },
              bind: "shares",
            },
          },
        ],
      },
    ],
  };
}
