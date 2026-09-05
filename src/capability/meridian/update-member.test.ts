import { describe, expect, it } from "vitest";
import { readAriaSnapshot } from "../../surface/aria-snapshot.js";
import { resolveLocator } from "../../surface/resolve-locator.js";
import { FakeSurface } from "../../surface/fake-surface.js";
import {
  capturedMeridianTree,
  meridianUpdateMemberScript,
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
import { updateMemberCapability, updateMemberInputs, updateMemberOutputs } from "./update-member.js";

/**
 * The MERIDIAN update-member Capability, checked against the trees MERIDIAN
 * actually served and replayed end-to-end against the fake for all three
 * endings: a valid single-step save that reaches the "MEMBER INFORMATION
 * UPDATED" confirmation, and the two validation refusals a bad e-mail or phone
 * is turned back with. What is proven is that its Locators address real controls
 * the whole way to the confirmation, that it is single-step with no review, and
 * that Replay reads the refusals as `INVALID_EMAIL` / `INVALID_PHONE` rather than
 * errors.
 */
const INPUTS = {
  memberNumber: "100234",
  email: "replay-verify@example.com",
  phone: "555-0155",
  mailingAddress: "9 Verify Lane, Checkstown",
} as const;

describe("the MERIDIAN update-member Capability", () => {
  it("validates against the Capability schema", () => {
    expect(capabilitySchema.safeParse(updateMemberCapability()).success).toBe(true);
  });

  it("is declared mutating, so approval gates whether it replays unattended", () => {
    expect(updateMemberCapability().contract.effects).toBe("mutating");
  });

  it("publishes the JSON Schema Zod generates for its inputs and outputs", () => {
    const { contract } = updateMemberCapability();

    expect(contract.inputs).toEqual(jsonSchemaFor(updateMemberInputs));
    expect(contract.outputs).toEqual(jsonSchemaFor(updateMemberOutputs));
  });

  it("is single-step: there is no review step between the form and the post", () => {
    const [base] = updateMemberCapability().recordings;
    if (base === undefined || !("steps" in base)) throw new Error("no base Recording");

    // "Save Changes" is the one and only submit; there is no intermediate review
    // wait, unlike open-share's wait-for-review between Continue and the post.
    const clicks = base.steps.filter((step) => step.action.kind === "click").map((step) => step.id);
    expect(clicks).toEqual(["run-search", "select-member", "open-update-form", "save"]);
  });

  it("addresses the search-by, value, and Search controls on the captured inquiry form", () => {
    const form = readAriaSnapshot(capturedMeridianTree("members-search"));

    for (const stepId of ["choose-search-by", "fill-member-number", "run-search"]) {
      expect(resolveLocator(form, locatorOf(stepId))).toHaveLength(1);
    }
  });

  it("addresses the record's Update Member Information action link", () => {
    const record = readAriaSnapshot(capturedMeridianTree("member-100234"));

    expect(resolveLocator(record, locatorOf("open-update-form"))).toHaveLength(1);
  });

  it("addresses the E-mail, Phone, Address, and Save Changes controls on the captured form", () => {
    const form = readAriaSnapshot(capturedMeridianTree("update"));

    for (const stepId of ["fill-email", "fill-phone", "fill-address", "save"]) {
      expect(resolveLocator(form, locatorOf(stepId))).toHaveLength(1);
    }
  });

  it("reads nothing — the confirmation carries no id, so outputs are empty", () => {
    const [base] = updateMemberCapability().recordings;
    if (base === undefined || !("steps" in base)) throw new Error("no base Recording");

    expect(base.steps.filter((step) => step.action.kind === "read")).toHaveLength(0);
    expect(updateMemberCapability().contract.outputs).toEqual(jsonSchemaFor(updateMemberOutputs));
  });

  it("matches success only on the saved screen", () => {
    expect(holdsOn("update-complete", "success")).toBe(true);
    expect(holdsOn("update", "success")).toBe(false);
    expect(holdsOn("update-invalid-email", "success")).toBe(false);
    expect(holdsOn("update-invalid-phone", "success")).toBe(false);
  });

  it("matches INVALID_EMAIL only on the invalid-email screen", () => {
    expect(holdsOn("update-invalid-email", "INVALID_EMAIL")).toBe(true);
    expect(holdsOn("update-invalid-phone", "INVALID_EMAIL")).toBe(false);
    expect(holdsOn("update-complete", "INVALID_EMAIL")).toBe(false);
  });

  it("matches INVALID_PHONE only on the invalid-phone screen", () => {
    expect(holdsOn("update-invalid-phone", "INVALID_PHONE")).toBe(true);
    expect(holdsOn("update-invalid-email", "INVALID_PHONE")).toBe(false);
    expect(holdsOn("update-complete", "INVALID_PHONE")).toBe(false);
  });

  it("replays a valid single-step save through to the saved confirmation", async () => {
    const surface = new FakeSurface(meridianUpdateMemberScript("saved"));

    const result = await replayCapability(surface, updateMemberCapability(), INPUTS, { baseUrl: BASE });

    expect(result.kind).toBe("success");
    if (result.kind !== "success") return;
    expect(result.outputs).toEqual({});
  });

  it("reports INVALID_EMAIL when the e-mail is not in a valid format", async () => {
    const surface = new FakeSurface(meridianUpdateMemberScript("invalid-email"));

    const result = await replayCapability(surface, updateMemberCapability(), INPUTS, {
      baseUrl: BASE,
      recoverableConditions: (await loadSurfaceProfile(surfacesDir(), "meridian")).recoverableConditions,
    });

    expect(result).toEqual({ kind: "business-outcome", name: "INVALID_EMAIL", step: "wait-for-saved" });
  });

  it("reports INVALID_PHONE when the phone number is not valid", async () => {
    const surface = new FakeSurface(meridianUpdateMemberScript("invalid-phone"));

    const result = await replayCapability(surface, updateMemberCapability(), INPUTS, {
      baseUrl: BASE,
      recoverableConditions: (await loadSurfaceProfile(surfacesDir(), "meridian")).recoverableConditions,
    });

    expect(result).toEqual({ kind: "business-outcome", name: "INVALID_PHONE", step: "wait-for-saved" });
  });

  it("walks the whole flow through the real policy gate", async () => {
    const profile = await loadSurfaceProfile(surfacesDir(), "meridian");
    const gated = new PolicyGatedSurface(new FakeSurface(meridianUpdateMemberScript("saved")), profile, {
      mayMutate: true,
    });

    const result = await replayCapability(gated, updateMemberCapability(), INPUTS, {
      baseUrl: profile.baseUrl,
      recoverableConditions: profile.recoverableConditions,
    });

    expect(result.kind).toBe("success");
  });

  it("is committed as the file a caller actually reads", async () => {
    const committed = await loadCapability(capabilitiesDir(), "update-member", 1);

    expect(committed).toEqual(updateMemberCapability());
  });
});

/** The Locator a named Step addresses, with its input references filled in. */
function locatorOf(stepId: string): Locator {
  const [base] = updateMemberCapability().recordings;
  if (base === undefined || !("steps" in base)) throw new Error("no base Recording");

  const step = base.steps.find((candidate) => candidate.id === stepId);
  if (step === undefined) throw new Error(`no Step "${stepId}"`);
  if (!("locator" in step.action)) throw new Error(`Step "${stepId}" addresses no control`);

  return substituteLocator(step.action.locator, INPUTS);
}

/** Whether a Terminal State's predicate holds on one captured screen. */
function holdsOn(slug: string, name: "success" | "INVALID_EMAIL" | "INVALID_PHONE"): boolean {
  const nodes = readAriaSnapshot(capturedMeridianTree(slug));
  return matchesPredicate(nodes, predicateOf(name), INPUTS);
}

/** One Terminal State's predicate, by name. */
function predicateOf(name: "success" | "INVALID_EMAIL" | "INVALID_PHONE"): Predicate {
  const state = updateMemberCapability().contract.terminalStates.find(
    (candidate) => (candidate.kind === "success" ? "success" : candidate.name) === name,
  );
  if (state === undefined) throw new Error(`no Terminal State "${name}"`);
  return state.when;
}
