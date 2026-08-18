import { describe, expect, it } from "vitest";
import { accountLookupCapability } from "../capability/parabank/account-lookup.js";
import { capabilitySchema, type Capability } from "../capability/schema.js";
import { mandateFor } from "./mandate.js";

/**
 * What a run is allowed to do, decided once before it starts.
 *
 * ADR 0007 splits this by phase on purpose: during Replay a mutating Capability
 * runs only if it has been marked approved. The decision is a static rule over
 * two declared fields — never the model's, and never inferred from what a
 * control happens to be labelled.
 */
describe("the mandate a Capability replays under", () => {
  it("lets a read-only Capability run, with no licence to change anything", () => {
    // Not merely "allowed": the mandate it gets is what stops it navigating to
    // a mutating route by mistake, which is a contradiction the gate catches.
    expect(mandateFor(accountLookupCapability())).toEqual({ allowed: true, mayMutate: false });
  });

  it("refuses a mutating Capability nobody has approved, and says why", () => {
    const result = mandateFor(mutating("draft"));

    expect(result.allowed).toBe(false);
    expect(result.allowed === false && result.reason).toMatch(
      /"open-account@1" can change data and is still a draft/,
    );
  });

  it("lets an approved mutating Capability change data", () => {
    expect(mandateFor(mutating("approved"))).toEqual({ allowed: true, mayMutate: true });
  });

  it("does not let approval widen a read-only Capability", () => {
    // Approval answers "may this run at all", not "what may it touch". A
    // read-only Capability that had been approved still has no business on a
    // route that can move money.
    expect(mandateFor({ ...accountLookupCapability(), approval: "approved" })).toEqual({
      allowed: true,
      mayMutate: false,
    });
  });

  it("treats a Capability that says nothing about approval as a draft", () => {
    // The recorder in #10 writes these unattended. Approval by omission is the
    // one way this rule could quietly stop meaning anything.
    const parsed = capabilitySchema.parse({ ...mutating("draft"), approval: undefined });

    expect(parsed.approval).toBe("draft");
    expect(mandateFor(parsed).allowed).toBe(false);
  });
});

/** A minimal mutating Capability — the shape #12 will fill in for real. */
function mutating(approval: "draft" | "approved"): Capability {
  return capabilitySchema.parse({
    id: "open-account",
    version: 1,
    surface: "parabank",
    approval,
    contract: {
      summary: "Open a new account and reach the confirmation screen.",
      inputs: { type: "object", properties: {} },
      outputs: { type: "object", properties: {} },
      effects: "mutating",
      terminalStates: [
        {
          kind: "success",
          when: {
            kind: "present",
            locator: { role: "heading", name: { kind: "literal", value: "Account Opened!" } },
          },
        },
      ],
    },
    recordings: [
      {
        variant: "base",
        steps: [
          {
            id: "open-form",
            action: { kind: "navigate", url: { kind: "literal", value: "/openaccount.htm" } },
          },
        ],
      },
    ],
  });
}
