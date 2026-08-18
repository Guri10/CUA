import { describe, expect, it } from "vitest";
import { accountLookupCapability } from "../capability/parabank/account-lookup.js";
import { BASE_VARIANT, capabilitySchema, type Capability } from "../capability/schema.js";
import { FakeSurface, type Script } from "../surface/fake-surface.js";
import { parabankScript, PARABANK_CAPTURED_BASE_URL } from "../surface/parabank/fake-script.js";
import { replayCapability } from "./replay.js";

const options = { baseUrl: PARABANK_CAPTURED_BASE_URL };

/** The account the committed snapshots were captured against. */
const CAPTURED_ACCOUNT = "12345";

function parabank(): FakeSurface {
  return new FakeSurface(parabankScript());
}

/**
 * The tracer bullet: the whole replay path, with no model in it and no browser
 * either.
 *
 * The fake answers from the accessibility trees real ParaBank served, and
 * resolves Locators by the same rules the browser does, so a run that works
 * here is a run whose Locators address real controls. What it cannot prove is
 * that the application still behaves the way the capture said — that is what
 * `replay.e2e.test.ts` is for.
 */
describe("replaying a Capability", () => {
  it("returns the outputs its Contract declares", async () => {
    const result = await replayCapability(
      parabank(),
      accountLookupCapability(),
      { accountId: CAPTURED_ACCOUNT },
      options,
    );

    expect(result).toEqual({
      kind: "success",
      outputs: { accountType: "CHECKING", balance: "-$2300.00" },
    });
  });

  it("substitutes the run's inputs into the Steps that carry blanks", async () => {
    // The same Recording, an account the customer does not hold. The Step that
    // stops the run names the number this run supplied rather than the one the
    // Recording was written against, which is the blank having been filled in.
    //
    // Today that is a Hard Failure. #6 is where the Capability's declared
    // ACCOUNT_NOT_FOUND is matched instead, against a real ParaBank response —
    // this is the seam it changes.
    const result = await replayCapability(
      parabank(),
      accountLookupCapability(),
      { accountId: "99999" },
      options,
    );

    expect(result).toEqual({
      kind: "hard-failure",
      step: "open-account",
      expected: `click on link "99999" (exact)`,
      observed: "no control matched",
      url: `${PARABANK_CAPTURED_BASE_URL}/overview.htm`,
    });
  });

  it("checks the inputs against the Contract before touching the screen", async () => {
    await expect(replayCapability(parabank(), accountLookupCapability(), {}, options)).rejects.toThrow(
      /account-lookup@1[\s\S]*accountId/,
    );
  });

  it("refuses an input the Contract does not declare", async () => {
    // Every declared input supplied, plus one that is not. A misspelled input
    // that was quietly dropped would run the Recording with the blank unfilled.
    await expect(
      replayCapability(
        parabank(),
        accountLookupCapability(),
        { accountId: "12345", acountId: "12345" },
        options,
      ),
    ).rejects.toThrow(/acountId/);
  });

  it("verifies the success Terminal State rather than assuming the last Step meant success", async () => {
    // Every Step of this Recording completes, and the screen it leaves the run
    // on is not the one its Contract calls success. A run that reported success
    // because it ran out of Steps would pass here.
    const result = await replayCapability(parabank(), stopsShortCapability(), {}, options);

    expect(result).toEqual({
      kind: "hard-failure",
      step: "open-overview",
      expected: `heading "Account Details" present`,
      observed: "the success Terminal State did not match",
      url: `${PARABANK_CAPTURED_BASE_URL}/overview.htm`,
    });
  });

  it("coerces an extracted value to the type its Contract declares", async () => {
    // A read returns the text of a control. The Contract is what says what that
    // text means, and here it says the account number is a number.
    const result = await replayCapability(
      parabank(),
      numericAccountCapability(),
      { accountId: CAPTURED_ACCOUNT },
      options,
    );

    expect(result).toEqual({ kind: "success", outputs: { accountNumber: 12345 } });
  });

  it("reports a Step whose control is not on the screen", async () => {
    const result = await replayCapability(parabank(), missingControlCapability(), {}, options);

    expect(result).toEqual({
      kind: "hard-failure",
      step: "read-sort-code",
      expected: `read of cell #1 within row "Sort Code:"`,
      observed: "no control matched",
      url: `${PARABANK_CAPTURED_BASE_URL}/overview.htm`,
    });
  });

  it("masks the session token in the screen it reports", async () => {
    // ParaBank carries its session token in the URL, and ADR 0006 classes one a
    // Secret: never written, with no flag to disable it. A failure report is
    // the one value on this path that gets printed to a terminal and a CI log,
    // so it is exactly where a live token would escape.
    const result = await replayCapability(
      new FakeSurface(sessionInTheUrl()),
      readsAMissingRowCapability(),
      { accountId: CAPTURED_ACCOUNT },
      options,
    );

    expect(result).toMatchObject({ kind: "hard-failure" });
    if (result.kind !== "hard-failure") return;
    expect(result.url).toContain("jsessionid=[REDACTED]");
    expect(result.url).not.toContain("ABC123");
  });

  it("reports a Step whose Locator matches more than one control", async () => {
    // Taking the first match is how a Replay reads the wrong row and reports
    // success, so an ambiguous Locator stops the run.
    const result = await replayCapability(parabank(), ambiguousCapability(), {}, options);

    expect(result.kind).toBe("hard-failure");
    expect(result.kind === "hard-failure" && result.observed).toMatch(/^\d+ controls matched$/);
  });
});

/** A Capability whose Steps all succeed on a screen its Contract does not call success. */
function stopsShortCapability(): Capability {
  return capabilitySchema.parse({
    id: "stops-short",
    version: 1,
    surface: "parabank",
    contract: {
      summary: "Arrive at the overview and call the account detail screen success.",
      inputs: { type: "object", properties: {} },
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
        ],
      },
    ],
  });
}

/** The same flow, declaring the account number an integer rather than text. */
function numericAccountCapability(): Capability {
  return capabilitySchema.parse({
    id: "numeric-account",
    version: 1,
    surface: "parabank",
    contract: {
      summary: "Read an account number off the overview as a number.",
      inputs: { type: "object", properties: { accountId: { type: "string" } }, required: ["accountId"] },
      outputs: {
        type: "object",
        properties: { accountNumber: { type: "integer" } },
        required: ["accountNumber"],
      },
      effects: "read-only",
      terminalStates: [
        {
          kind: "success",
          when: {
            kind: "present",
            locator: { role: "heading", name: { kind: "literal", value: "Accounts Overview" } },
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
            id: "read-number",
            action: {
              kind: "read",
              locator: { role: "link", name: { kind: "input", input: "accountId" }, exact: true },
              bind: "accountNumber",
            },
          },
        ],
      },
    ],
  });
}

/** A Recording that reads a row the overview does not have. */
function missingControlCapability(): Capability {
  return capabilitySchema.parse({
    id: "missing-control",
    version: 1,
    surface: "parabank",
    contract: {
      summary: "Read a field ParaBank does not show.",
      inputs: { type: "object", properties: {} },
      outputs: { type: "object", properties: { sortCode: { type: "string" } }, required: ["sortCode"] },
      effects: "read-only",
      terminalStates: [
        {
          kind: "success",
          when: {
            kind: "present",
            locator: { role: "heading", name: { kind: "literal", value: "Accounts Overview" } },
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
            id: "read-sort-code",
            action: {
              kind: "read",
              locator: {
                role: "cell",
                ordinal: 1,
                within: { role: "row", name: { kind: "literal", value: "Sort Code:" } },
              },
              bind: "sortCode",
            },
          },
        ],
      },
    ],
  });
}

/** A Recording that reads "a cell", of which the overview has many. */
function ambiguousCapability(): Capability {
  return capabilitySchema.parse({
    id: "ambiguous",
    version: 1,
    surface: "parabank",
    contract: {
      summary: "Read an unscoped cell off a table with several.",
      inputs: { type: "object", properties: {} },
      outputs: { type: "object", properties: { anything: { type: "string" } }, required: ["anything"] },
      effects: "read-only",
      terminalStates: [
        {
          kind: "success",
          when: {
            kind: "present",
            locator: { role: "heading", name: { kind: "literal", value: "Accounts Overview" } },
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
            id: "read-a-cell",
            action: { kind: "read", locator: { role: "cell" }, bind: "anything" },
          },
        ],
      },
    ],
  });
}

/**
 * The same captured screens, with the account detail reached at a URL carrying
 * a session token — which is what real ParaBank serves.
 */
function sessionInTheUrl(): Script {
  return {
    screens: parabankScript().screens.map((screen) =>
      screen.name === "account-detail" ? { ...screen, url: `${screen.url};jsessionid=ABC123` } : screen,
    ),
  };
}

/** Clicks through to the account detail, then reads a row it does not have. */
function readsAMissingRowCapability(): Capability {
  return capabilitySchema.parse({
    id: "reads-a-missing-row",
    version: 1,
    surface: "parabank",
    contract: {
      summary: "Reach the account detail and read a field ParaBank does not show.",
      inputs: { type: "object", properties: { accountId: { type: "string" } }, required: ["accountId"] },
      outputs: { type: "object", properties: { sortCode: { type: "string" } }, required: ["sortCode"] },
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
              locator: { role: "link", name: { kind: "input", input: "accountId" }, exact: true },
            },
          },
          {
            id: "read-sort-code",
            action: {
              kind: "read",
              locator: {
                role: "cell",
                ordinal: 1,
                within: { role: "row", name: { kind: "literal", value: "Sort Code:" } },
              },
              bind: "sortCode",
            },
          },
        ],
      },
    ],
  });
}
