import { describe, expect, it } from "vitest";
import { readAriaSnapshot } from "../../surface/aria-snapshot.js";
import { resolveLocator } from "../../surface/resolve-locator.js";
import { FakeSurface } from "../../surface/fake-surface.js";
import {
  capturedMeridianTree,
  meridianOpenShareScript,
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
import { openShareCapability, openShareInputs, openShareOutputs } from "./open-share.js";

/**
 * The MERIDIAN open-share Capability, checked against the trees MERIDIAN
 * actually served and replayed end-to-end against the fake for both endings: a
 * valid request that walks form → review → post and returns the confirmation
 * number and new share id, and a deposit under the minimum stopped at the
 * validation refusal. What is proven is that its Locators address real controls
 * the whole way to the opened confirmation, that the hidden token is never read,
 * and that Replay reads the minimum-deposit refusal as `MINIMUM_DEPOSIT` rather
 * than an error.
 */
const INPUTS = {
  memberNumber: "100234",
  shareType: "S0001 - Regular Shares",
  initialDeposit: "5.00",
} as const;

/** The confirmation number and new share id the captured opened screen carries. */
const CONFIRMATION = "CN480249";
const NEW_SHARE_ID = "100234-S0001-30";

describe("the MERIDIAN open-share Capability", () => {
  it("validates against the Capability schema", () => {
    expect(capabilitySchema.safeParse(openShareCapability()).success).toBe(true);
  });

  it("is declared mutating, so approval gates whether it replays unattended", () => {
    expect(openShareCapability().contract.effects).toBe("mutating");
  });

  it("publishes the JSON Schema Zod generates for its inputs and outputs", () => {
    const { contract } = openShareCapability();

    expect(contract.inputs).toEqual(jsonSchemaFor(openShareInputs));
    expect(contract.outputs).toEqual(jsonSchemaFor(openShareOutputs));
  });

  it("addresses the search-by, value, and Search controls on the captured inquiry form", () => {
    const form = readAriaSnapshot(capturedMeridianTree("members-search"));

    for (const stepId of ["choose-search-by", "fill-member-number", "run-search"]) {
      expect(resolveLocator(form, locatorOf(stepId))).toHaveLength(1);
    }
  });

  it("addresses the record's Open New Share action link", () => {
    const record = readAriaSnapshot(capturedMeridianTree("member-100234"));

    expect(resolveLocator(record, locatorOf("open-share-form"))).toHaveLength(1);
  });

  it("addresses the Share Type, Deposit, and Continue controls on the captured form", () => {
    const form = readAriaSnapshot(capturedMeridianTree("open-share"));

    for (const stepId of ["choose-share-type", "fill-deposit", "continue"]) {
      expect(resolveLocator(form, locatorOf(stepId))).toHaveLength(1);
    }
  });

  it("addresses the Open Share control on the captured review", () => {
    const review = readAriaSnapshot(capturedMeridianTree("open-share-review"));

    expect(resolveLocator(review, locatorOf("open-share"))).toHaveLength(1);
  });

  it("reads the confirmation number and new share id from exactly one cell each on the opened screen", () => {
    const opened = readAriaSnapshot(capturedMeridianTree("open-share-complete"));

    const confirmation = resolveLocator(opened, locatorOf("read-confirmation"));
    expect(confirmation).toHaveLength(1);
    expect(confirmation[0]?.name).toBe(CONFIRMATION);

    const shareId = resolveLocator(opened, locatorOf("read-share-id"));
    expect(shareId).toHaveLength(1);
    expect(shareId[0]?.name).toBe(NEW_SHARE_ID);
  });

  it("never reads the hidden per-transaction token — the form submit carries it", () => {
    const [base] = openShareCapability().recordings;
    if (base === undefined || !("steps" in base)) throw new Error("no base Recording");

    const reads = base.steps.filter((step) => step.action.kind === "read");
    expect(reads.map((step) => step.id)).toEqual(["read-confirmation", "read-share-id"]);
  });

  it("recognises the CONFIRM review only on the review screen, not on the refusal screen", () => {
    const reviewHeading = locatorOf("wait-for-review");

    expect(resolveLocator(readAriaSnapshot(capturedMeridianTree("open-share-review")), reviewHeading)).toHaveLength(1);
    expect(
      resolveLocator(readAriaSnapshot(capturedMeridianTree("open-share-min-deposit")), reviewHeading),
    ).toHaveLength(0);
  });

  it("matches success only on the opened screen", () => {
    expect(holdsOn("open-share-complete", "success")).toBe(true);
    expect(holdsOn("open-share-review", "success")).toBe(false);
    expect(holdsOn("open-share-min-deposit", "success")).toBe(false);
  });

  it("matches MINIMUM_DEPOSIT only on the minimum-deposit refusal screen", () => {
    expect(holdsOn("open-share-min-deposit", "MINIMUM_DEPOSIT")).toBe(true);
    expect(holdsOn("open-share-review", "MINIMUM_DEPOSIT")).toBe(false);
    expect(holdsOn("open-share-complete", "MINIMUM_DEPOSIT")).toBe(false);
  });

  it("replays through form → review → post and returns the confirmation number and new share id", async () => {
    const surface = new FakeSurface(meridianOpenShareScript("opened"));

    const result = await replayCapability(surface, openShareCapability(), INPUTS, { baseUrl: BASE });

    expect(result.kind).toBe("success");
    if (result.kind !== "success") return;
    expect(result.outputs["confirmationNumber"]).toBe(CONFIRMATION);
    expect(result.outputs["newShareId"]).toBe(NEW_SHARE_ID);
  });

  it("reports MINIMUM_DEPOSIT when the deposit is under the minimum", async () => {
    const surface = new FakeSurface(meridianOpenShareScript("min-deposit"));

    const result = await replayCapability(surface, openShareCapability(), INPUTS, {
      baseUrl: BASE,
      recoverableConditions: (await loadSurfaceProfile(surfacesDir(), "meridian")).recoverableConditions,
    });

    expect(result).toEqual({
      kind: "business-outcome",
      name: "MINIMUM_DEPOSIT",
      step: "wait-for-review",
    });
  });

  it("walks the whole flow through the real policy gate, review and post routes included", async () => {
    // As with funds-transfer: the bare-FakeSurface replays never see the gate.
    // This replays an approved run through the real meridian profile, proving the
    // /open-share/review and /open-share/post sub-routes are on the allowlist —
    // without them the wait after "Continue" is refused and the run hard-fails
    // before it can open the share.
    const profile = await loadSurfaceProfile(surfacesDir(), "meridian");
    const gated = new PolicyGatedSurface(new FakeSurface(meridianOpenShareScript("opened")), profile, {
      mayMutate: true,
    });

    const result = await replayCapability(gated, openShareCapability(), INPUTS, {
      baseUrl: profile.baseUrl,
      recoverableConditions: profile.recoverableConditions,
    });

    expect(result.kind).toBe("success");
    if (result.kind !== "success") return;
    expect(result.outputs["confirmationNumber"]).toBe(CONFIRMATION);
    expect(result.outputs["newShareId"]).toBe(NEW_SHARE_ID);
  });

  it("reaches MINIMUM_DEPOSIT through the real policy gate, not a refusal", async () => {
    const profile = await loadSurfaceProfile(surfacesDir(), "meridian");
    const gated = new PolicyGatedSurface(new FakeSurface(meridianOpenShareScript("min-deposit")), profile, {
      mayMutate: true,
    });

    const result = await replayCapability(gated, openShareCapability(), INPUTS, {
      baseUrl: profile.baseUrl,
      recoverableConditions: profile.recoverableConditions,
    });

    expect(result).toEqual({
      kind: "business-outcome",
      name: "MINIMUM_DEPOSIT",
      step: "wait-for-review",
    });
  });

  it("is committed as the file a caller actually reads", async () => {
    const committed = await loadCapability(capabilitiesDir(), "open-share", 1);

    expect(committed).toEqual(openShareCapability());
  });
});

/** The Locator a named Step addresses, with its input references filled in. */
function locatorOf(stepId: string): Locator {
  const [base] = openShareCapability().recordings;
  if (base === undefined || !("steps" in base)) throw new Error("no base Recording");

  const step = base.steps.find((candidate) => candidate.id === stepId);
  if (step === undefined) throw new Error(`no Step "${stepId}"`);
  if (!("locator" in step.action)) throw new Error(`Step "${stepId}" addresses no control`);

  return substituteLocator(step.action.locator, INPUTS);
}

/** Whether a Terminal State's predicate holds on one captured screen. */
function holdsOn(slug: string, name: "success" | "MINIMUM_DEPOSIT"): boolean {
  const nodes = readAriaSnapshot(capturedMeridianTree(slug));
  return matchesPredicate(nodes, predicateOf(name), INPUTS);
}

/** One Terminal State's predicate, by name. */
function predicateOf(name: "success" | "MINIMUM_DEPOSIT"): Predicate {
  const state = openShareCapability().contract.terminalStates.find(
    (candidate) => (candidate.kind === "success" ? "success" : candidate.name) === name,
  );
  if (state === undefined) throw new Error(`no Terminal State "${name}"`);
  return state.when;
}
