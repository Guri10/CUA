/**
 * The hand-written lookup Capability: given an account number, return that
 * account's type and balance from ParaBank.
 *
 * It exists so that the replay path has something real to run before discovery
 * can generate one, and so that the schema is exercised by a Capability rather
 * than only by its own tests. It is written from the accessibility trees
 * committed under `evidence/` — the screens ParaBank actually served — and
 * every Locator in it is resolved against those trees in
 * `account-lookup.test.ts`.
 *
 * This module is the source; `capabilities/account-lookup/1.json` is the
 * artefact, written by `npm run capability:write` and committed so that a
 * reviewer reads the Capability as a file rather than as code. A test fails if
 * the two have drifted apart.
 *
 * The flow does not log in. Login belongs to the Surface profile (#7), because
 * it is a property of the application rather than of any one Capability — the
 * day the form gains a field, one description changes instead of every
 * Recording.
 */
import { z } from "zod";
import { jsonSchemaFor } from "../json-schema.js";
import { BASE_VARIANT, type Capability } from "../schema.js";

export const accountLookupInputs = z.object({
  accountId: z
    .string()
    .min(1)
    .describe("The account number, as it appears on the accounts overview."),
});

export const accountLookupOutputs = z.object({
  accountType: z.string().describe(`The account's type, as displayed — "CHECKING" or "SAVINGS".`),
  /**
   * ADR 0006 classes a balance as Sensitive: returned to the caller in full,
   * masked in persisted evidence. It stays the displayed string rather than a
   * number so that the caller sees what an operator would see, and so that no
   * currency or sign convention is silently invented here.
   */
  balance: z.string().describe(`The account's balance, as displayed — for example "-$2300.00".`),
});

/**
 * The Locator for the value cell of one label/value row on the account detail
 * screen. ParaBank renders those as a two-cell row whose first cell is the
 * label, so the value is the second cell scoped by the row its label names.
 */
function detailRowValue(label: string) {
  return {
    role: "cell",
    ordinal: 1,
    within: { role: "row", name: { kind: "literal", value: label } },
  } as const;
}

/**
 * The same row's value cell, but matched only once it carries a currency
 * symbol.
 *
 * Being on the screen is not the same as the screen being readable: ParaBank
 * fills its value cells from a request that finishes after load. This is that
 * distinction expressed in the one vocabulary ADR 0001 allows — a proxy, since
 * the accessibility tree cannot say "this control has a value", but one scoped
 * to the single cell about to be read rather than to any row on the page.
 *
 * It is one function because the checkpoint Step and the success Terminal State
 * must agree exactly. Two copies of it drifting apart is a Capability that
 * waits for one thing and declares success on another.
 */
function detailRowValueArrived(label: string) {
  return {
    role: "cell",
    name: { kind: "literal", value: "$" },
    within: { role: "row", name: { kind: "literal", value: label } },
  } as const;
}

/**
 * The accounts table, once its rows have actually arrived.
 *
 * ParaBank renders the table's structure immediately and fills it from a
 * request that finishes later, so "the overview is on screen" and "the overview
 * is readable" are different claims. A row whose accessible name has picked up
 * a currency symbol is the accessibility-vocabulary way to tell them apart; the
 * ordinal asks for one such row rather than all eleven.
 *
 * One function because the checkpoint Step and the ACCOUNT_NOT_FOUND Terminal
 * State must agree exactly. Without this in the Terminal State, an overview
 * whose rows never arrived would satisfy "no link with that number" and a
 * broken screen would be reported as a customer not holding the account —
 * a Hard Failure quietly answered as a Business Outcome, which is the worst
 * direction for this system to be wrong in.
 */
function accountsTableArrived() {
  return { role: "row", name: { kind: "literal", value: "$" }, ordinal: 0 } as const;
}

export function accountLookupCapability(): Capability {
  return {
    id: "account-lookup",
    version: 1,
    surface: "parabank",
    // Read-only, so approval decides nothing here — it is stated rather than
    // defaulted because a reviewer reading the file should not have to know
    // what the schema fills in.
    approval: "draft",
    contract: {
      summary: "Look up one account's type and balance by account number.",
      inputs: jsonSchemaFor(accountLookupInputs),
      outputs: jsonSchemaFor(accountLookupOutputs),
      effects: "read-only",
      terminalStates: [
        {
          kind: "success",
          when: {
            kind: "all",
            of: [
              {
                kind: "present",
                locator: { role: "heading", name: { kind: "literal", value: "Account Details" } },
              },
              { kind: "present", locator: detailRowValueArrived("Balance:") },
            ],
          },
        },
        {
          kind: "business-outcome",
          name: "ACCOUNT_NOT_FOUND",
          when: {
            kind: "all",
            of: [
              // Scoped to the overview on purpose. "No link with that number"
              // is true of every other screen in the application too, so
              // without this the outcome would match the moment the run
              // arrived anywhere else — including on success.
              {
                kind: "present",
                locator: { role: "heading", name: { kind: "literal", value: "Accounts Overview" } },
              },
              { kind: "present", locator: accountsTableArrived() },
              {
                kind: "absent",
                locator: {
                  role: "link",
                  name: { kind: "input", input: "accountId" },
                  exact: true,
                },
              },
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
            // A path, not a URL. The origin belongs to the Surface profile, so
            // a Recording carrying one would be tied to the installation it
            // was recorded against.
            id: "open-overview",
            action: { kind: "navigate", url: { kind: "literal", value: "/overview.htm" } },
          },
          {
            id: "wait-for-accounts",
            action: { kind: "waitFor", locator: accountsTableArrived() },
          },
          {
            // `exact`, because account numbers are prefixes of one another:
            // a substring match on "1234" would also take "12345".
            id: "open-account",
            action: {
              kind: "click",
              locator: {
                role: "link",
                name: { kind: "input", input: "accountId" },
                exact: true,
              },
            },
          },
          {
            id: "wait-for-balance",
            action: { kind: "waitFor", locator: detailRowValueArrived("Balance:") },
          },
          {
            id: "read-account-type",
            action: { kind: "read", locator: detailRowValue("Account Type:"), bind: "accountType" },
          },
          {
            id: "read-balance",
            action: { kind: "read", locator: detailRowValue("Balance:"), bind: "balance" },
          },
        ],
      },
    ],
  };
}
