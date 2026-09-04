import { describe, expect, it } from "vitest";
import { readAriaSnapshot } from "../../surface/aria-snapshot.js";
import { resolveLocator } from "../../surface/resolve-locator.js";
import { FakeSurface } from "../../surface/fake-surface.js";
import {
  capturedMeridianTree,
  meridianMemberLookupScript,
  MERIDIAN_CAPTURED_BASE_URL as BASE,
} from "../../surface/meridian/fake-script.js";
import type { Locator } from "../../surface/surface.js";
import { substituteLocator } from "../../replay/substitute.js";
import { matchesPredicate } from "../../replay/predicate.js";
import { loadSurfaceProfile, surfacesDir } from "../../policy/profile.js";
import { replayCapability } from "../../replay/replay.js";
import { capabilitySchema, type Predicate } from "../schema.js";
import { jsonSchemaFor } from "../json-schema.js";
import { capabilitiesDir, loadCapability } from "../storage.js";
import { memberBalanceCapability, memberBalanceInputs, memberBalanceOutputs } from "./member-balance.js";

/**
 * The MERIDIAN member-balance Capability, checked against the trees MERIDIAN
 * actually served and replayed end-to-end against the fake for both outcomes: a
 * member whose record lists its shares, and no such member. What is proven is
 * that its Locators address real controls, that its `readEach` reads every
 * share row into the list output with each column scoped within its own row,
 * and that Replay reads each ending as the design says — success carrying the
 * shares, or `NOT_FOUND`.
 */
const FOUND = { memberNumber: "100234" } as const;
const NO_MATCH = { memberNumber: "999999" } as const;

describe("the MERIDIAN member-balance Capability", () => {
  it("validates against the Capability schema", () => {
    expect(capabilitySchema.safeParse(memberBalanceCapability()).success).toBe(true);
  });

  it("publishes the JSON Schema Zod generates for its inputs and outputs", () => {
    const { contract } = memberBalanceCapability();

    expect(contract.inputs).toEqual(jsonSchemaFor(memberBalanceInputs));
    expect(contract.outputs).toEqual(jsonSchemaFor(memberBalanceOutputs));
  });

  it("addresses the search-by, value, and Search controls on the captured inquiry form", () => {
    const form = readAriaSnapshot(capturedMeridianTree("members-search"));

    for (const stepId of ["choose-search-by", "fill-value", "run-search"]) {
      expect(resolveLocator(form, locatorOf(stepId))).toHaveLength(1);
    }
  });

  it("matches every share row on the captured record and nothing above the table", () => {
    const record = readAriaSnapshot(capturedMeridianTree("member-100234"));

    // The captured member holds twenty shares; the row Locator picks up exactly
    // those and not the column-header row or the identity rows, which carry no
    // "$".
    expect(resolveLocator(record, rowsLocator())).toHaveLength(20);
  });

  it("matches success only on the record", () => {
    expect(holdsOn("member-100234", "success")).toBe(true);
    expect(holdsOn("members-unique", "success")).toBe(false);
    expect(holdsOn("members-not-found", "success")).toBe(false);
  });

  it("matches NOT_FOUND only on the no-match inquiry screen", () => {
    expect(holdsOn("members-not-found", "NOT_FOUND")).toBe(true);
    expect(holdsOn("members-unique", "NOT_FOUND")).toBe(false);
    expect(holdsOn("member-100234", "NOT_FOUND")).toBe(false);
  });

  it("replays a found member through to the record and returns every share", async () => {
    const surface = new FakeSurface(meridianMemberLookupScript("unique"));

    const result = await replayCapability(surface, memberBalanceCapability(), FOUND, { baseUrl: BASE });

    expect(result.kind).toBe("success");
    if (result.kind !== "success") return;

    const shares = result.outputs["shares"] as ReadonlyArray<Record<string, string>>;
    expect(shares).toHaveLength(20);
    // The first row, read with each column scoped within it.
    expect(shares[0]).toEqual({
      shareId: "100234-S0001",
      type: "Regular Shares",
      balance: "$2,499.00",
      status: "HOLD [HOLD]",
    });
    // A row whose balance ("$25.00") repeats elsewhere on the record still reads
    // its own row's values — the point of scoping each column within its row.
    expect(shares).toContainEqual({
      shareId: "100234-MMKT-4",
      type: "Money Market",
      balance: "$25.00",
      status: "HOLD [HOLD]",
    });
  });

  it("reports NOT_FOUND when no member matched", async () => {
    const surface = new FakeSurface(meridianMemberLookupScript("none"));

    const result = await replayCapability(surface, memberBalanceCapability(), NO_MATCH, {
      baseUrl: BASE,
      // Passed so the realistic order is exercised: a Recoverable Condition is
      // asked about before a Business Outcome, and neither MERIDIAN condition
      // must swallow the no-match inquiry screen.
      recoverableConditions: (await loadSurfaceProfile(surfacesDir(), "meridian")).recoverableConditions,
    });

    expect(result).toEqual({ kind: "business-outcome", name: "NOT_FOUND", step: "wait-for-results" });
  });

  it("is committed as the file a caller actually reads", async () => {
    const committed = await loadCapability(capabilitiesDir(), "member-balance", 1);

    expect(committed).toEqual(memberBalanceCapability());
  });
});

/** The Locator a named Step addresses, with its input references filled in. */
function locatorOf(stepId: string): Locator {
  const [base] = memberBalanceCapability().recordings;
  if (base === undefined || !("steps" in base)) throw new Error("no base Recording");

  const step = base.steps.find((candidate) => candidate.id === stepId);
  if (step === undefined) throw new Error(`no Step "${stepId}"`);
  if (!("locator" in step.action)) throw new Error(`Step "${stepId}" addresses no control`);

  return substituteLocator(step.action.locator, FOUND);
}

/** The `rows` Locator of the readEach Step, with its input references filled in. */
function rowsLocator(): Locator {
  const [base] = memberBalanceCapability().recordings;
  if (base === undefined || !("steps" in base)) throw new Error("no base Recording");

  const step = base.steps.find((candidate) => candidate.id === "read-shares");
  if (step === undefined || step.action.kind !== "readEach") throw new Error("no readEach Step");

  return substituteLocator(step.action.rows, FOUND);
}

/** Whether a Terminal State's predicate holds on one captured screen. */
function holdsOn(slug: string, name: "success" | "NOT_FOUND"): boolean {
  const nodes = readAriaSnapshot(capturedMeridianTree(slug));
  return matchesPredicate(nodes, predicateOf(name), FOUND);
}

/** One Terminal State's predicate, by name. */
function predicateOf(name: "success" | "NOT_FOUND"): Predicate {
  const state = memberBalanceCapability().contract.terminalStates.find(
    (candidate) => (candidate.kind === "success" ? "success" : candidate.name) === name,
  );
  if (state === undefined) throw new Error(`no Terminal State "${name}"`);
  return state.when;
}
