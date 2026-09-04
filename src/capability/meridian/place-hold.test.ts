import { describe, expect, it } from "vitest";
import { readAriaSnapshot } from "../../surface/aria-snapshot.js";
import { resolveLocator } from "../../surface/resolve-locator.js";
import { FakeSurface } from "../../surface/fake-surface.js";
import {
  capturedMeridianTree,
  meridianHoldScript,
  MERIDIAN_CAPTURED_BASE_URL as BASE,
} from "../../surface/meridian/fake-script.js";
import type { Locator } from "../../surface/surface.js";
import { substituteLocator } from "../../replay/substitute.js";
import { matchesPredicate } from "../../replay/predicate.js";
import { loadSurfaceProfile, surfacesDir } from "../../policy/profile.js";
import { PolicyGatedSurface } from "../../policy/policy-gated-surface.js";
import { replayCapability } from "../../replay/replay.js";
import { capabilitySchema, type Predicate } from "../schema.js";
import { jsonSchemaFor } from "../json-schema.js";
import { capabilitiesDir, loadCapability } from "../storage.js";
import { placeHoldCapability, placeHoldInputs, placeHoldOutputs } from "./place-hold.js";

/**
 * The MERIDIAN place-hold Capability, checked against the trees MERIDIAN
 * actually served and replayed end-to-end against the fake for both endings: a
 * supervisor session that walks form → review → post and returns the
 * confirmation number, and a teller session stopped at the 403. What is proven
 * is that its Locators address real controls the whole way to the applied
 * confirmation, that the hidden token is never read, and that Replay reads the
 * override-required screen as `SUPERVISOR_OVERRIDE_REQUIRED` rather than an error.
 */
const INPUTS = {
  memberNumber: "100234",
  shareId: "100234-S0001 - Regular Shares",
  reasonCode: "FRAUD - Suspected fraud",
  notes: "flagged by branch",
} as const;

/** The confirmation number the captured applied screen carries. */
const CONFIRMATION = "CN480245";

describe("the MERIDIAN place-hold Capability", () => {
  it("validates against the Capability schema", () => {
    expect(capabilitySchema.safeParse(placeHoldCapability()).success).toBe(true);
  });

  it("is declared mutating, so approval gates whether it replays unattended", () => {
    expect(placeHoldCapability().contract.effects).toBe("mutating");
  });

  it("publishes the JSON Schema Zod generates for its inputs and outputs", () => {
    const { contract } = placeHoldCapability();

    expect(contract.inputs).toEqual(jsonSchemaFor(placeHoldInputs));
    expect(contract.outputs).toEqual(jsonSchemaFor(placeHoldOutputs));
  });

  it("addresses the search-by, value, and Search controls on the captured inquiry form", () => {
    const form = readAriaSnapshot(capturedMeridianTree("members-search"));

    for (const stepId of ["choose-search-by", "fill-member-number", "run-search"]) {
      expect(resolveLocator(form, locatorOf(stepId))).toHaveLength(1);
    }
  });

  it("addresses the record's Place Account Hold action link", () => {
    const record = readAriaSnapshot(capturedMeridianTree("member-100234"));

    expect(resolveLocator(record, locatorOf("open-hold"))).toHaveLength(1);
  });

  it("addresses the Share, Reason, Notes, and Continue controls on the captured form", () => {
    const form = readAriaSnapshot(capturedMeridianTree("hold"));

    for (const stepId of ["choose-share", "choose-reason", "fill-notes", "continue"]) {
      expect(resolveLocator(form, locatorOf(stepId))).toHaveLength(1);
    }
  });

  it("addresses the Apply Hold control on the captured review", () => {
    const review = readAriaSnapshot(capturedMeridianTree("hold-review"));

    expect(resolveLocator(review, locatorOf("apply"))).toHaveLength(1);
  });

  it("reads the confirmation number from exactly one cell on the applied screen", () => {
    const applied = readAriaSnapshot(capturedMeridianTree("hold-complete"));
    const matches = resolveLocator(applied, locatorOf("read-confirmation"));

    expect(matches).toHaveLength(1);
    expect(matches[0]?.name).toBe(CONFIRMATION);
  });

  it("never reads the hidden per-transaction token — the form submit carries it", () => {
    const [base] = placeHoldCapability().recordings;
    if (base === undefined || !("steps" in base)) throw new Error("no base Recording");

    const reads = base.steps.filter((step) => step.action.kind === "read");
    expect(reads.map((step) => step.id)).toEqual(["read-confirmation"]);
  });

  it("recognises the CONFIRM review only on the review screen, not on the override screen", () => {
    const reviewHeading = locatorOf("wait-for-review");

    expect(resolveLocator(readAriaSnapshot(capturedMeridianTree("hold-review")), reviewHeading)).toHaveLength(1);
    expect(
      resolveLocator(readAriaSnapshot(capturedMeridianTree("hold-override-required")), reviewHeading),
    ).toHaveLength(0);
  });

  it("matches success only on the applied screen", () => {
    expect(holdsOn("hold-complete", "success")).toBe(true);
    expect(holdsOn("hold-review", "success")).toBe(false);
    expect(holdsOn("hold-override-required", "success")).toBe(false);
  });

  it("matches SUPERVISOR_OVERRIDE_REQUIRED only on the override screen", () => {
    expect(holdsOn("hold-override-required", "SUPERVISOR_OVERRIDE_REQUIRED")).toBe(true);
    expect(holdsOn("hold-review", "SUPERVISOR_OVERRIDE_REQUIRED")).toBe(false);
    expect(holdsOn("hold-complete", "SUPERVISOR_OVERRIDE_REQUIRED")).toBe(false);
  });

  it("replays a supervisor hold through form → review → post and returns the confirmation number", async () => {
    const surface = new FakeSurface(meridianHoldScript("applied"));

    const result = await replayCapability(surface, placeHoldCapability(), INPUTS, { baseUrl: BASE });

    expect(result.kind).toBe("success");
    if (result.kind !== "success") return;
    expect(result.outputs["confirmationNumber"]).toBe(CONFIRMATION);
  });

  it("replays with no notes — the optional field defaults to empty and the hold still applies", async () => {
    const surface = new FakeSurface(meridianHoldScript("applied"));
    const { notes: _omitted, ...withoutNotes } = INPUTS;

    const result = await replayCapability(surface, placeHoldCapability(), withoutNotes, { baseUrl: BASE });

    expect(result.kind).toBe("success");
  });

  it("reports SUPERVISOR_OVERRIDE_REQUIRED when a teller is not authorized", async () => {
    const surface = new FakeSurface(meridianHoldScript("override-required"));

    const result = await replayCapability(surface, placeHoldCapability(), INPUTS, {
      baseUrl: BASE,
      recoverableConditions: (await loadSurfaceProfile(surfacesDir(), "meridian")).recoverableConditions,
    });

    expect(result).toEqual({
      kind: "business-outcome",
      name: "SUPERVISOR_OVERRIDE_REQUIRED",
      step: "wait-for-review",
    });
  });

  it("walks the whole flow through the real policy gate, review and post routes included", async () => {
    // As with funds-transfer: the bare-FakeSurface replays never see the gate.
    // This replays an approved supervisor run through the real meridian profile,
    // proving the /hold/review and /hold/post sub-routes are on the allowlist —
    // without them the wait after "Continue" is refused and the run hard-fails
    // before it can apply the hold.
    const profile = await loadSurfaceProfile(surfacesDir(), "meridian");
    const gated = new PolicyGatedSurface(new FakeSurface(meridianHoldScript("applied")), profile, {
      mayMutate: true,
    });

    const result = await replayCapability(gated, placeHoldCapability(), INPUTS, {
      baseUrl: profile.baseUrl,
      recoverableConditions: profile.recoverableConditions,
    });

    expect(result.kind).toBe("success");
    if (result.kind !== "success") return;
    expect(result.outputs["confirmationNumber"]).toBe(CONFIRMATION);
  });

  it("reaches SUPERVISOR_OVERRIDE_REQUIRED through the real policy gate, not a refusal", async () => {
    const profile = await loadSurfaceProfile(surfacesDir(), "meridian");
    const gated = new PolicyGatedSurface(new FakeSurface(meridianHoldScript("override-required")), profile, {
      mayMutate: true,
    });

    const result = await replayCapability(gated, placeHoldCapability(), INPUTS, {
      baseUrl: profile.baseUrl,
      recoverableConditions: profile.recoverableConditions,
    });

    expect(result).toEqual({
      kind: "business-outcome",
      name: "SUPERVISOR_OVERRIDE_REQUIRED",
      step: "wait-for-review",
    });
  });

  it("is committed as the file a caller actually reads", async () => {
    const committed = await loadCapability(capabilitiesDir(), "place-hold", 1);

    expect(committed).toEqual(placeHoldCapability());
  });
});

/** The Locator a named Step addresses, with its input references filled in. */
function locatorOf(stepId: string): Locator {
  const [base] = placeHoldCapability().recordings;
  if (base === undefined || !("steps" in base)) throw new Error("no base Recording");

  const step = base.steps.find((candidate) => candidate.id === stepId);
  if (step === undefined) throw new Error(`no Step "${stepId}"`);
  if (!("locator" in step.action)) throw new Error(`Step "${stepId}" addresses no control`);

  return substituteLocator(step.action.locator, INPUTS);
}

/** Whether a Terminal State's predicate holds on one captured screen. */
function holdsOn(slug: string, name: "success" | "SUPERVISOR_OVERRIDE_REQUIRED"): boolean {
  const nodes = readAriaSnapshot(capturedMeridianTree(slug));
  return matchesPredicate(nodes, predicateOf(name), INPUTS);
}

/** One Terminal State's predicate, by name. */
function predicateOf(name: "success" | "SUPERVISOR_OVERRIDE_REQUIRED"): Predicate {
  const state = placeHoldCapability().contract.terminalStates.find(
    (candidate) => (candidate.kind === "success" ? "success" : candidate.name) === name,
  );
  if (state === undefined) throw new Error(`no Terminal State "${name}"`);
  return state.when;
}
