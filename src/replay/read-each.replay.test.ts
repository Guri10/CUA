import { describe, expect, it } from "vitest";
import { z } from "zod";
import { jsonSchemaFor } from "../capability/json-schema.js";
import { BASE_VARIANT, capabilitySchema, type Capability } from "../capability/schema.js";
import { FakeSurface, type Script } from "../surface/fake-surface.js";
import {
  capturedMeridianTree,
  MERIDIAN_CAPTURED_BASE_URL as BASE,
} from "../surface/meridian/fake-script.js";
import { replayCapability } from "./replay.js";

/**
 * Replay end-to-end with a `readEach` Step: a Capability that reads a member's
 * shares into a list output and declares success on the record screen. What is
 * proven is that a list survives the whole replay path — bound off the Surface,
 * past the text coercion that a scalar read goes through, and validated against
 * an array-of-records Contract — and comes back as the success value, not
 * collapsed to a string or rejected as an un-coercible output.
 */
const shareRow = { role: "row", name: { kind: "literal", value: "$" } } as const;
// The wait needs a singular control — a share row addressed by ordinal, since the
// bare row Locator matches all twenty and `waitFor` reads many matches as
// ambiguous. Only `readEach` is allowed to match the whole set.
const firstShareRow = { ...shareRow, ordinal: 0 } as const;

const balanceOutputs = z.object({
  shares: z
    .array(
      z.object({
        shareId: z.string(),
        type: z.string(),
        balance: z.string(),
        status: z.string(),
      }),
    )
    .describe("Every share on the member record, in the order the screen lists them."),
});

function memberBalanceProbe(): Capability {
  return {
    id: "member-balance-probe",
    version: 1,
    surface: "meridian",
    approval: "draft",
    contract: {
      summary: "Read a member's shares into a list.",
      inputs: jsonSchemaFor(z.object({})),
      outputs: jsonSchemaFor(balanceOutputs),
      effects: "read-only",
      terminalStates: [
        {
          kind: "success",
          when: {
            kind: "present",
            locator: { role: "heading", name: { kind: "literal", value: "MEMBER RECORD" }, exact: true },
          },
        },
      ],
    },
    recordings: [
      {
        variant: BASE_VARIANT,
        steps: [
          { id: "open-record", action: { kind: "navigate", url: { kind: "literal", value: "/members/100234" } } },
          { id: "wait-for-shares", action: { kind: "waitFor", locator: firstShareRow } },
          {
            id: "read-shares",
            action: {
              kind: "readEach",
              rows: shareRow,
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

function recordScript(): Script {
  const url = `${BASE}/members/100234`;
  return { screens: [{ name: "record", url, tree: capturedMeridianTree("member-100234") }] };
}

describe("replaying a Capability that binds a readEach list output", () => {
  it("validates against the Capability schema", () => {
    expect(capabilitySchema.safeParse(memberBalanceProbe()).success).toBe(true);
  });

  it("returns the member's shares as the success outputs", async () => {
    const surface = new FakeSurface(recordScript());

    const result = await replayCapability(surface, memberBalanceProbe(), {}, { baseUrl: BASE });

    expect(result.kind).toBe("success");
    if (result.kind !== "success") return;

    const shares = result.outputs["shares"] as ReadonlyArray<Record<string, string>>;
    expect(shares).toHaveLength(20);
    expect(shares[0]).toEqual({
      shareId: "100234-S0001",
      type: "Regular Shares",
      balance: "$2,499.00",
      status: "HOLD [HOLD]",
    });
  });
});
