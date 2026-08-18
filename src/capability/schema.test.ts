import { describe, expect, it } from "vitest";
import { capabilitySchema, isBaseRecording, type Capability } from "./schema.js";

/**
 * The one place a malformed Capability is caught. Each test here is a
 * structural rule the file format guarantees, so that everything downstream —
 * the executor, the recorder, the catalog — can read a loaded Capability
 * without re-checking it.
 */
describe("the Capability schema", () => {
  it("accepts a Capability with one base Recording", () => {
    const result = capabilitySchema.safeParse(lookupCapability());

    expect(result.success).toBe(true);
  });

  it("refuses a Contract with no success Terminal State", () => {
    const capability = lookupCapability();
    capability.contract.terminalStates = capability.contract.terminalStates.filter(
      (state) => state.kind !== "success",
    );

    expect(reasons(capability)).toContainEqual(expect.stringMatching(/exactly one success/i));
  });

  it("refuses a Contract with two success Terminal States", () => {
    const capability = lookupCapability();
    const success = capability.contract.terminalStates.find((state) => state.kind === "success")!;
    capability.contract.terminalStates.push(structuredClone(success));

    expect(reasons(capability)).toContainEqual(expect.stringMatching(/exactly one success/i));
  });

  it("refuses two Business Outcomes with the same name", () => {
    const capability = lookupCapability();
    const outcome = capability.contract.terminalStates.find(
      (state) => state.kind === "business-outcome",
    )!;
    capability.contract.terminalStates.push(structuredClone(outcome));

    expect(reasons(capability)).toContainEqual(expect.stringMatching(/ACCOUNT_NOT_FOUND/));
  });

  it("refuses a Recording that reuses a Step id", () => {
    // Step ids are what variant patches and failure reports refer to, so two
    // Steps answering to one id is a Recording that cannot be corrected or
    // reported on unambiguously.
    const capability = lookupCapability();
    const base = capability.recordings.find(isBaseRecording)!;
    base.steps[1]!.id = base.steps[0]!.id;

    expect(reasons(capability)).toContainEqual(expect.stringMatching(/open-overview/));
  });

  it("refuses a Capability with no base Recording", () => {
    const capability = lookupCapability();
    capability.recordings = [];

    expect(reasons(capability)).toContainEqual(expect.stringMatching(/exactly one base/i));
  });

  it("accepts a variant Recording patching a Step the base has", () => {
    const capability = lookupCapability();
    capability.recordings.push(renamedOverviewLink());

    expect(reasons(capability)).toEqual([]);
  });

  it("refuses a variant patch keyed by a Step the base does not have", () => {
    // A correction that names nothing is the failure mode of keying by id:
    // it applies silently to nothing and the Tenant runs the uncorrected flow.
    const capability = lookupCapability();
    capability.recordings.push({
      variant: "northwind",
      patch: { "open-statement": { action: { kind: "click", locator: { role: "link" } } } },
    });

    expect(reasons(capability)).toContainEqual(expect.stringMatching(/open-statement/));
  });

  it("refuses a variant patch that changes a Step's action kind", () => {
    const capability = lookupCapability();
    capability.recordings.push({
      variant: "northwind",
      patch: {
        "open-account": {
          action: {
            kind: "fill",
            locator: { role: "textbox" },
            value: { kind: "input", input: "accountId" },
          },
        },
      },
    });

    expect(reasons(capability)).toContainEqual(expect.stringMatching(/click.*fill|fill.*click/));
  });

  it("refuses a Step referencing an input the Contract does not declare", () => {
    const capability = lookupCapability();
    const base = capability.recordings.find(isBaseRecording)!;
    base.steps[1]!.action = {
      kind: "click",
      locator: { role: "link", name: { kind: "input", input: "customerId" } },
    };

    expect(reasons(capability)).toContainEqual(expect.stringMatching(/customerId/));
  });

  it("refuses a read bound to an output the Contract does not declare", () => {
    const capability = lookupCapability();
    const base = capability.recordings.find(isBaseRecording)!;
    base.steps[2]!.action = {
      kind: "read",
      locator: { role: "cell", ordinal: 0 },
      bind: "overdraft",
    };

    expect(reasons(capability)).toContainEqual(expect.stringMatching(/overdraft/));
  });

  it("refuses a declared output that no Step reads", () => {
    // The Contract promising a value the Recording never collects is a
    // Capability that succeeds and returns nothing for it.
    const capability = lookupCapability();
    capability.contract.outputs.properties["accountType"] = { type: "string" };
    capability.contract.outputs.required = ["balance", "accountType"];

    expect(reasons(capability)).toContainEqual(expect.stringMatching(/accountType/));
  });
});

/** Every reason the schema gave for refusing, flattened to one list. */
function reasons(capability: unknown): string[] {
  const result = capabilitySchema.safeParse(capability);
  if (result.success) return [];
  return result.error.issues.map((issue) => issue.message);
}

/** A Tenant whose overview names its account links differently. */
function renamedOverviewLink(): Capability["recordings"][number] {
  return {
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
  };
}

/**
 * The smallest Capability that is still a real one: an input referenced by a
 * Step, a read bound to a declared output, and both Terminal States ADR 0004
 * asks for.
 */
function lookupCapability(): Capability {
  return {
    id: "account-lookup",
    version: 1,
    surface: "parabank",
    contract: {
      summary: "Look up an account's balance.",
      inputs: {
        type: "object",
        properties: { accountId: { type: "string" } },
        required: ["accountId"],
      },
      outputs: {
        type: "object",
        properties: { balance: { type: "string" } },
        required: ["balance"],
      },
      effects: "read-only",
      terminalStates: [
        {
          kind: "success",
          when: {
            kind: "present",
            locator: { role: "heading", name: { kind: "literal", value: "Account Details" } },
          },
        },
        {
          kind: "business-outcome",
          name: "ACCOUNT_NOT_FOUND",
          when: {
            kind: "absent",
            locator: { role: "link", name: { kind: "input", input: "accountId" } },
          },
        },
      ],
    },
    recordings: [
      {
        variant: "base",
        steps: [
          {
            id: "open-overview",
            action: { kind: "navigate", url: { kind: "literal", value: "/overview.htm" } },
          },
          {
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
            id: "read-balance",
            action: {
              kind: "read",
              locator: { role: "cell", name: { kind: "literal", value: "$" }, ordinal: 0 },
              bind: "balance",
            },
          },
        ],
      },
    ],
  };
}
