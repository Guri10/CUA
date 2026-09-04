/**
 * The hand-written member-lookup Capability: find a MERIDIAN member by number or
 * by last name, return the member when the match is unique, and name the two
 * negative outcomes — no match, and several matches — as Business Outcomes the
 * caller acts on.
 *
 * It is written from the accessibility trees committed under
 * `evidence/accessibility-tree/meridian/` — the member-inquiry form, its
 * unique / no-match / several-matches results, and the member record a unique
 * match leads to — and every Locator in it is resolved against those trees in
 * `member-lookup.test.ts`. The trees were captured, not invented: see
 * `scripts/capture-meridian-members.ts`.
 *
 * This module is the source; `capabilities/member-lookup/1.json` is the artefact,
 * written by `npm run capability:write` and committed so a reviewer reads the
 * Capability as a file. A test fails if the two drift apart.
 *
 * The shape of the flow comes from how MERIDIAN's inquiry screen actually
 * behaves, which is worth reading before the Steps make sense:
 *
 * - A search — by either mode — always lands back on the inquiry screen with a
 *   results table, even for a single hit. It never redirects to the record. So a
 *   unique match is one row with one "Select" link, several matches are several
 *   rows with several "Select" links, and no match shows no results table at all.
 * - That difference is the discriminator, expressed in the ADR 0001 vocabulary
 *   with no counting: the Recording clicks "Select". One candidate means one
 *   "Select" link, so the click resolves and lands on the record — success. More
 *   than one means the "Select" Locator is ambiguous, so the click misses and the
 *   run is left on the results screen — `MULTIPLE_MATCHES`. None means the
 *   results header never arrives, so the wait before the click misses — `NOT_FOUND`.
 *
 * Two deliberate departures from the design table in `docs/meridian-capabilities.md`:
 *
 * - `by` is the combobox's own option labels ("Member Number" / "Last Name"),
 *   not the shorthand `number` / `name` the table sketches. The value is selected
 *   by its accessible name (the same way sign-on selects its branch), so it has
 *   to be the label MERIDIAN actually renders.
 * - The outputs are flat `memberNumber` and `name`, not a nested `member` object.
 *   A `read` returns the text of one control and the Contract coerces it by its
 *   declared scalar type; a nested object is not something a read can produce, so
 *   the honest Contract is the two fields the record screen actually shows. The
 *   candidate list the design mentions for `MULTIPLE_MATCHES` is not returned:
 *   a Business Outcome carries its name and where it was reached, not outputs.
 */
import { z } from "zod";
import { jsonSchemaFor } from "../json-schema.js";
import { BASE_VARIANT, type Capability, type StepLocator } from "../schema.js";

export const memberLookupInputs = z.object({
  by: z
    .enum(["Member Number", "Last Name"])
    .describe(`How to search, as the "Search by:" combobox lists it.`),
  q: z
    .string()
    .min(1)
    .describe("The value to search for — a member number, or a last name (matched as a substring)."),
});

export const memberLookupOutputs = z.object({
  memberNumber: z.string().describe(`The member's number, as the record shows it — for example "100234".`),
  /**
   * ADR 0006 classes a member's name Sensitive: returned to the caller in full,
   * masked in persisted evidence. It stays the displayed string ("Lovelace, Ada")
   * rather than being split, so the caller sees what an operator would see.
   */
  name: z.string().describe(`The member's name, as displayed — for example "Lovelace, Ada".`),
});

/**
 * The results table's header cell. It is present on the inquiry screen once a
 * search has matched anything — one hit or many — and absent when nothing
 * matched, which is the whole difference between `MULTIPLE_MATCHES` and
 * `NOT_FOUND`.
 *
 * `exact`, so it addresses the results header "Member No." and not the record
 * screen's "Member No.:" label, which carries it as a prefix.
 */
function resultsHeader(): StepLocator {
  return { role: "cell", name: { kind: "literal", value: "Member No." }, exact: true };
}

/**
 * A candidate's "Select" link. On a unique match there is exactly one, so the
 * click resolves; on several matches there are several, so it is ambiguous and
 * the click misses — which is how the run tells the two apart without counting
 * rows. `exact` because it is the only handle the row offers.
 */
function selectLink(): StepLocator {
  return { role: "link", name: { kind: "literal", value: "Select" }, exact: true };
}

/**
 * The value cell of the record's identity row, by ordinal. MERIDIAN packs two
 * label/value pairs into one row — "Member No.: 100234 Name: Lovelace, Ada" —
 * so the number is cell 1 and the name is cell 3, scoped to the row its first
 * label names. The `within` name is a substring on purpose: the row's accessible
 * name is the whole concatenation, and only this row carries "Member No.:".
 */
function identityCell(ordinal: number): StepLocator {
  return {
    role: "cell",
    ordinal,
    within: { role: "row", name: { kind: "literal", value: "Member No.:" } },
  };
}

export function memberLookupCapability(): Capability {
  return {
    id: "member-lookup",
    version: 1,
    surface: "meridian",
    // Read-only, so approval decides nothing here — stated rather than defaulted
    // so a reviewer reading the file need not know what the schema fills in.
    approval: "draft",
    contract: {
      summary: "Look up a member by number or last name; return the member when the match is unique.",
      inputs: jsonSchemaFor(memberLookupInputs),
      outputs: jsonSchemaFor(memberLookupOutputs),
      effects: "read-only",
      terminalStates: [
        {
          // The unique match, followed through "Select" to the member record.
          kind: "success",
          when: {
            kind: "present",
            locator: { role: "heading", name: { kind: "literal", value: "MEMBER RECORD" }, exact: true },
          },
        },
        {
          // No match: standing on the inquiry screen with no results table.
          // Scoped to that screen's own heading so it cannot match the record,
          // and requiring the results header to be absent so it cannot match a
          // screen that did find someone.
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
        {
          // Several matches: the results table is on screen. Only ever evaluated
          // when the "Select" click was ambiguous, i.e. there was more than one
          // candidate — a unique match clicks through to the record before any
          // Terminal State is read, so this needs no row count to be correct.
          kind: "business-outcome",
          name: "MULTIPLE_MATCHES",
          when: { kind: "present", locator: resultsHeader() },
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
            // One combobox on the screen; its options are the labels `by` takes.
            id: "choose-search-by",
            action: {
              kind: "select",
              locator: { role: "combobox", ordinal: 0 },
              option: { kind: "input", input: "by" },
            },
          },
          {
            // One unnamed textbox — the value field, reachable only by ordinal,
            // the ADR 0001 case MERIDIAN shares with its sign-on inputs.
            id: "fill-value",
            action: {
              kind: "fill",
              locator: { role: "textbox", ordinal: 0 },
              value: { kind: "input", input: "q" },
            },
          },
          {
            id: "run-search",
            action: { kind: "click", locator: { role: "button", name: { kind: "literal", value: "Search" } } },
          },
          {
            // Missing here means no results table arrived — no match. Read before
            // the "Select" click so a genuine miss becomes NOT_FOUND rather than
            // an unfound link.
            id: "wait-for-results",
            action: { kind: "waitFor", locator: resultsHeader() },
          },
          {
            // One "Select" resolves and leads to the record; several is ambiguous
            // and misses, leaving the run on the results screen — MULTIPLE_MATCHES.
            id: "select-member",
            action: { kind: "click", locator: selectLink() },
          },
          {
            id: "wait-for-record",
            action: {
              kind: "waitFor",
              locator: { role: "heading", name: { kind: "literal", value: "MEMBER RECORD" }, exact: true },
            },
          },
          { id: "read-number", action: { kind: "read", locator: identityCell(1), bind: "memberNumber" } },
          { id: "read-name", action: { kind: "read", locator: identityCell(3), bind: "name" } },
        ],
      },
    ],
  };
}
