import { describe, expect, it } from "vitest";
import { resolveRecording } from "./resolve-recording.js";
import { BASE_VARIANT, type Capability } from "./schema.js";

/**
 * Per-site differences as small corrections to one shared Recording, so that a
 * change to the shared flow propagates instead of being duplicated per Tenant.
 */
describe("resolving a Recording for a Tenant", () => {
  it("gives the base Steps, in order, for the base variant", () => {
    const steps = resolveRecording(capabilityWithVariant(), BASE_VARIANT);

    expect(steps.map((step) => step.id)).toEqual(["open-overview", "open-account"]);
    expect(steps[1]!.action).toEqual({
      kind: "click",
      locator: { role: "link", name: { kind: "input", input: "accountId" } },
    });
  });

  it("applies a variant's patch to the Step it names, leaving the rest alone", () => {
    const steps = resolveRecording(capabilityWithVariant(), "northwind");

    expect(steps.map((step) => step.id)).toEqual(["open-overview", "open-account"]);
    expect(steps[0]!.action).toEqual({
      kind: "navigate",
      url: { kind: "literal", value: "/overview.htm" },
    });
    expect(steps[1]!.action).toEqual({
      kind: "click",
      locator: {
        role: "link",
        name: { kind: "input", input: "accountId" },
        within: { role: "table", name: { kind: "literal", value: "Accounts" } },
      },
    });
  });

  it("gives the base Steps for a Tenant that has no Recording of its own", () => {
    // The point of a shared Recording: a Tenant that needs no correction runs
    // the shared flow, and a change to it reaches them without a per-site copy.
    const steps = resolveRecording(capabilityWithVariant(), "eastbank");

    expect(steps).toEqual(resolveRecording(capabilityWithVariant(), BASE_VARIANT));
  });
});

function capabilityWithVariant(): Capability {
  return {
    id: "account-lookup",
    version: 1,
    surface: "parabank",
    approval: "draft",
    contract: {
      summary: "Look up an account's balance.",
      inputs: { type: "object", properties: { accountId: { type: "string" } } },
      outputs: { type: "object", properties: {} },
      effects: "read-only",
      terminalStates: [
        {
          kind: "success",
          when: {
            kind: "present",
            locator: { role: "heading", name: { kind: "literal", value: "Account Details" } },
          },
        },
      ],
    },
    recordings: [
      {
        variant: BASE_VARIANT,
        steps: [
          {
            id: "open-overview",
            action: { kind: "navigate", url: { kind: "literal", value: "/overview.htm" } },
          },
          {
            id: "open-account",
            action: {
              kind: "click",
              locator: { role: "link", name: { kind: "input", input: "accountId" } },
            },
          },
        ],
      },
      {
        variant: "northwind",
        patch: {
          "open-account": {
            action: {
              kind: "click",
              locator: {
                role: "link",
                name: { kind: "input", input: "accountId" },
                within: { role: "table", name: { kind: "literal", value: "Accounts" } },
              },
            },
          },
        },
      },
    ],
  };
}
