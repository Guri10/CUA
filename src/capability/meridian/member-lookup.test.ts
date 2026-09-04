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
import { memberLookupCapability, memberLookupInputs, memberLookupOutputs } from "./member-lookup.js";

/**
 * The MERIDIAN member-lookup Capability, checked against the trees MERIDIAN
 * actually served and replayed end-to-end against the fake for all three
 * outcomes: a unique match followed through to the record, no match, and several
 * matches. What is proven is that its Locators address real controls, that its
 * predicates tell the three result screens apart, and that Replay reads each
 * ending as the design says — success, `NOT_FOUND`, `MULTIPLE_MATCHES`.
 */
const BY_NUMBER = { by: "Member Number", q: "100234" } as const;
const BY_NAME = { by: "Last Name", q: "o" } as const;
const NO_MATCH = { by: "Member Number", q: "999999" } as const;

describe("the MERIDIAN member-lookup Capability", () => {
  it("validates against the Capability schema", () => {
    expect(capabilitySchema.safeParse(memberLookupCapability()).success).toBe(true);
  });

  it("publishes the JSON Schema Zod generates for its inputs and outputs", () => {
    const { contract } = memberLookupCapability();

    expect(contract.inputs).toEqual(jsonSchemaFor(memberLookupInputs));
    expect(contract.outputs).toEqual(jsonSchemaFor(memberLookupOutputs));
  });

  it("addresses the search-by, value, and Search controls on the captured inquiry form", () => {
    const form = readAriaSnapshot(capturedMeridianTree("members-search"));

    for (const stepId of ["choose-search-by", "fill-value", "run-search"]) {
      expect(resolveLocator(form, locatorOf(stepId))).toHaveLength(1);
    }
  });

  it("reads the member number and name off the captured record", () => {
    const record = readAriaSnapshot(capturedMeridianTree("member-100234"));

    expect(resolveLocator(record, locatorOf("read-number"))).toHaveLength(1);
    expect(resolveLocator(record, locatorOf("read-name"))).toHaveLength(1);
  });

  it("matches success only on the record", () => {
    expect(holdsOn("member-100234", "success", BY_NUMBER)).toBe(true);
    expect(holdsOn("members-unique", "success", BY_NUMBER)).toBe(false);
    expect(holdsOn("members-candidates", "success", BY_NAME)).toBe(false);
    expect(holdsOn("members-not-found", "success", NO_MATCH)).toBe(false);
  });

  it("matches NOT_FOUND only on the no-match inquiry screen", () => {
    expect(holdsOn("members-not-found", "NOT_FOUND", NO_MATCH)).toBe(true);
    expect(holdsOn("members-unique", "NOT_FOUND", BY_NUMBER)).toBe(false);
    expect(holdsOn("members-candidates", "NOT_FOUND", BY_NAME)).toBe(false);
    expect(holdsOn("member-100234", "NOT_FOUND", BY_NUMBER)).toBe(false);
  });

  it("matches MULTIPLE_MATCHES on a results screen and not where there are no results", () => {
    expect(holdsOn("members-candidates", "MULTIPLE_MATCHES", BY_NAME)).toBe(true);
    // The predicate alone does not tell one match from several — it holds on the
    // unique screen too, which has the same results header. What tells them apart
    // is Terminal-State order (ADR 0004): a unique match's "Select" click resolves
    // and reaches the record before any Business Outcome is read, so this
    // predicate is only ever evaluated once the click was ambiguous. Asserted so
    // that "narrowing" it to also exclude the unique screen — which would break
    // nothing observable but erode the documented invariant — cannot pass quietly.
    expect(holdsOn("members-unique", "MULTIPLE_MATCHES", BY_NUMBER)).toBe(true);
    expect(holdsOn("members-not-found", "MULTIPLE_MATCHES", NO_MATCH)).toBe(false);
    expect(holdsOn("member-100234", "MULTIPLE_MATCHES", BY_NUMBER)).toBe(false);
  });

  it("replays a unique match through to the record and returns the member", async () => {
    const surface = new FakeSurface(meridianMemberLookupScript("unique"));

    const result = await replayCapability(surface, memberLookupCapability(), BY_NUMBER, {
      baseUrl: BASE,
    });

    expect(result).toEqual({
      kind: "success",
      outputs: { memberNumber: "100234", name: "Lovelace, Ada" },
    });
  });

  it("reports NOT_FOUND when nothing matched", async () => {
    const surface = new FakeSurface(meridianMemberLookupScript("none"));

    const result = await replayCapability(surface, memberLookupCapability(), NO_MATCH, {
      baseUrl: BASE,
      // Passed so the realistic order is exercised: a Recoverable Condition is
      // asked about before a Business Outcome, and neither MERIDIAN condition
      // must swallow the no-match inquiry screen.
      recoverableConditions: (await loadSurfaceProfile(surfacesDir(), "meridian")).recoverableConditions,
    });

    expect(result).toEqual({ kind: "business-outcome", name: "NOT_FOUND", step: "wait-for-results" });
  });

  it("reports MULTIPLE_MATCHES when several members matched", async () => {
    const surface = new FakeSurface(meridianMemberLookupScript("multiple"));

    const result = await replayCapability(surface, memberLookupCapability(), BY_NAME, {
      baseUrl: BASE,
      recoverableConditions: (await loadSurfaceProfile(surfacesDir(), "meridian")).recoverableConditions,
    });

    // The ambiguous "Select" click is where the run stops and the outcome is read.
    expect(result).toEqual({
      kind: "business-outcome",
      name: "MULTIPLE_MATCHES",
      step: "select-member",
    });
  });

  it("is committed as the file a caller actually reads", async () => {
    const committed = await loadCapability(capabilitiesDir(), "member-lookup", 1);

    expect(committed).toEqual(memberLookupCapability());
  });
});

/** The Locator a named Step addresses, with its input references filled in. */
function locatorOf(stepId: string): Locator {
  const [base] = memberLookupCapability().recordings;
  if (base === undefined || !("steps" in base)) throw new Error("no base Recording");

  const step = base.steps.find((candidate) => candidate.id === stepId);
  if (step === undefined) throw new Error(`no Step "${stepId}"`);
  if (!("locator" in step.action)) throw new Error(`Step "${stepId}" addresses no control`);

  return substituteLocator(step.action.locator, BY_NUMBER);
}

/** Whether a Terminal State's predicate holds on one captured screen. */
function holdsOn(
  slug: string,
  name: "success" | "NOT_FOUND" | "MULTIPLE_MATCHES",
  inputs: Readonly<Record<string, unknown>>,
): boolean {
  const nodes = readAriaSnapshot(capturedMeridianTree(slug));
  return matchesPredicate(nodes, predicateOf(name), inputs);
}

/** One Terminal State's predicate, by name. */
function predicateOf(name: "success" | "NOT_FOUND" | "MULTIPLE_MATCHES"): Predicate {
  const state = memberLookupCapability().contract.terminalStates.find(
    (candidate) => (candidate.kind === "success" ? "success" : candidate.name) === name,
  );
  if (state === undefined) throw new Error(`no Terminal State "${name}"`);
  return state.when;
}
