import { describe, expect, it } from "vitest";
import { readAriaSnapshot } from "../../surface/aria-snapshot.js";
import { resolveLocator } from "../../surface/resolve-locator.js";
import { FakeSurface } from "../../surface/fake-surface.js";
import {
  capturedMeridianTree,
  meridianTransferScript,
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
import { fundsTransferCapability, fundsTransferInputs, fundsTransferOutputs } from "./funds-transfer.js";

/**
 * The MERIDIAN funds-transfer Capability, checked against the trees MERIDIAN
 * actually served and replayed end-to-end against the fake for all three
 * endings: a posted transfer that returns its confirmation number, a source
 * share on HOLD, and an amount over the source balance. What is proven is that
 * its Locators address real controls the whole way from the inquiry search to
 * the posted confirmation, that the hidden token is never read, and that Replay
 * reads each ending as the design says — success carrying the confirmation
 * number, or the right Business Outcome.
 */
const INPUTS = {
  memberNumber: "100234",
  fromShare: "100234-S0001-14 - Regular Shares ($100.00)",
  toShare: "100234-S0001-6 - Regular Shares ($40.00)",
  amount: "1.00",
  memo: "rent",
} as const;

/** The confirmation number the captured posted screen carries. */
const CONFIRMATION = "CN480243";

describe("the MERIDIAN funds-transfer Capability", () => {
  it("validates against the Capability schema", () => {
    expect(capabilitySchema.safeParse(fundsTransferCapability()).success).toBe(true);
  });

  it("is declared mutating, so approval gates whether it replays unattended", () => {
    expect(fundsTransferCapability().contract.effects).toBe("mutating");
  });

  it("publishes the JSON Schema Zod generates for its inputs and outputs", () => {
    const { contract } = fundsTransferCapability();

    expect(contract.inputs).toEqual(jsonSchemaFor(fundsTransferInputs));
    expect(contract.outputs).toEqual(jsonSchemaFor(fundsTransferOutputs));
  });

  it("addresses the search-by, value, and Search controls on the captured inquiry form", () => {
    const form = readAriaSnapshot(capturedMeridianTree("members-search"));

    for (const stepId of ["choose-search-by", "fill-member-number", "run-search"]) {
      expect(resolveLocator(form, locatorOf(stepId))).toHaveLength(1);
    }
  });

  it("addresses the record's Funds Transfer action link", () => {
    const record = readAriaSnapshot(capturedMeridianTree("member-100234"));

    expect(resolveLocator(record, locatorOf("open-transfer"))).toHaveLength(1);
  });

  it("addresses the From, To, Amount, Memo, and Continue controls on the captured form", () => {
    const form = readAriaSnapshot(capturedMeridianTree("transfer"));

    for (const stepId of ["choose-from", "choose-to", "fill-amount", "fill-memo", "continue"]) {
      expect(resolveLocator(form, locatorOf(stepId))).toHaveLength(1);
    }
  });

  it("addresses the Post Transfer control on the captured review", () => {
    const review = readAriaSnapshot(capturedMeridianTree("transfer-review"));

    expect(resolveLocator(review, locatorOf("post"))).toHaveLength(1);
  });

  it("reads the confirmation number from exactly one cell on the posted screen", () => {
    const posted = readAriaSnapshot(capturedMeridianTree("transfer-complete"));
    const matches = resolveLocator(posted, locatorOf("read-confirmation"));

    expect(matches).toHaveLength(1);
    expect(matches[0]?.name).toBe(CONFIRMATION);
  });

  it("never reads the hidden per-transaction token — the form submit carries it", () => {
    const [base] = fundsTransferCapability().recordings;
    if (base === undefined || !("steps" in base)) throw new Error("no base Recording");

    // The only reads are the confirmation number; nothing addresses a token,
    // hidden field, or the like. The post is a click, not a read of a token.
    const reads = base.steps.filter((step) => step.action.kind === "read");
    expect(reads.map((step) => step.id)).toEqual(["read-confirmation"]);
  });

  it("recognises the CONFIRM review only on the review screen, not on either refusal", () => {
    const reviewHeading = locatorOf("wait-for-review");

    expect(resolveLocator(readAriaSnapshot(capturedMeridianTree("transfer-review")), reviewHeading)).toHaveLength(1);
    expect(
      resolveLocator(readAriaSnapshot(capturedMeridianTree("transfer-source-on-hold")), reviewHeading),
    ).toHaveLength(0);
    expect(
      resolveLocator(readAriaSnapshot(capturedMeridianTree("transfer-insufficient-funds")), reviewHeading),
    ).toHaveLength(0);
  });

  it("matches success only on the posted screen", () => {
    expect(holdsOn("transfer-complete", "success")).toBe(true);
    expect(holdsOn("transfer-review", "success")).toBe(false);
    expect(holdsOn("transfer-source-on-hold", "success")).toBe(false);
  });

  it("matches each Business Outcome only on its own refusal screen", () => {
    expect(holdsOn("transfer-source-on-hold", "SOURCE_ON_HOLD")).toBe(true);
    expect(holdsOn("transfer-insufficient-funds", "SOURCE_ON_HOLD")).toBe(false);

    expect(holdsOn("transfer-insufficient-funds", "INSUFFICIENT_FUNDS")).toBe(true);
    expect(holdsOn("transfer-source-on-hold", "INSUFFICIENT_FUNDS")).toBe(false);
  });

  it("replays a valid transfer through form → review → post and returns the confirmation number", async () => {
    const surface = new FakeSurface(meridianTransferScript("posted"));

    const result = await replayCapability(surface, fundsTransferCapability(), INPUTS, { baseUrl: BASE });

    expect(result.kind).toBe("success");
    if (result.kind !== "success") return;
    expect(result.outputs["confirmationNumber"]).toBe(CONFIRMATION);
  });

  it("replays with no memo — the optional field defaults to empty and the transfer still posts", async () => {
    const surface = new FakeSurface(meridianTransferScript("posted"));
    const { memo: _omitted, ...withoutMemo } = INPUTS;

    const result = await replayCapability(surface, fundsTransferCapability(), withoutMemo, { baseUrl: BASE });

    expect(result.kind).toBe("success");
  });

  it("reports SOURCE_ON_HOLD when the source share is on hold", async () => {
    const surface = new FakeSurface(meridianTransferScript("source-on-hold"));

    const result = await replayCapability(surface, fundsTransferCapability(), INPUTS, {
      baseUrl: BASE,
      recoverableConditions: (await loadSurfaceProfile(surfacesDir(), "meridian")).recoverableConditions,
    });

    expect(result).toEqual({ kind: "business-outcome", name: "SOURCE_ON_HOLD", step: "wait-for-review" });
  });

  it("reports INSUFFICIENT_FUNDS when the amount is over the source balance", async () => {
    const surface = new FakeSurface(meridianTransferScript("insufficient-funds"));

    const result = await replayCapability(surface, fundsTransferCapability(), INPUTS, {
      baseUrl: BASE,
      recoverableConditions: (await loadSurfaceProfile(surfacesDir(), "meridian")).recoverableConditions,
    });

    expect(result).toEqual({ kind: "business-outcome", name: "INSUFFICIENT_FUNDS", step: "wait-for-review" });
  });

  it("walks the whole flow through the real policy gate, review and post routes included", async () => {
    // The earlier replays use a bare FakeSurface, which never sees the gate. In
    // production replay wraps the Surface in a deny-by-default PolicyGatedSurface,
    // so this replays an approved run (mayMutate) through the real meridian
    // profile — proving the review and post sub-routes the flow reaches are on
    // the profile's allowlist. Without them the wait after "Continue" is refused
    // and the run hard-fails before it can post.
    const profile = await loadSurfaceProfile(surfacesDir(), "meridian");
    const gated = new PolicyGatedSurface(new FakeSurface(meridianTransferScript("posted")), profile, {
      mayMutate: true,
    });

    const result = await replayCapability(gated, fundsTransferCapability(), INPUTS, {
      baseUrl: profile.baseUrl,
      recoverableConditions: profile.recoverableConditions,
    });

    expect(result.kind).toBe("success");
    if (result.kind !== "success") return;
    expect(result.outputs["confirmationNumber"]).toBe(CONFIRMATION);
  });

  it("reaches each Business Outcome through the real policy gate, not a refusal", async () => {
    const profile = await loadSurfaceProfile(surfacesDir(), "meridian");

    for (const [outcome, name] of [
      ["source-on-hold", "SOURCE_ON_HOLD"],
      ["insufficient-funds", "INSUFFICIENT_FUNDS"],
    ] as const) {
      const gated = new PolicyGatedSurface(new FakeSurface(meridianTransferScript(outcome)), profile, {
        mayMutate: true,
      });

      const result = await replayCapability(gated, fundsTransferCapability(), INPUTS, {
        baseUrl: profile.baseUrl,
        recoverableConditions: profile.recoverableConditions,
      });

      expect(result).toEqual({ kind: "business-outcome", name, step: "wait-for-review" });
    }
  });

  it("is committed as the file a caller actually reads", async () => {
    const committed = await loadCapability(capabilitiesDir(), "funds-transfer", 1);

    expect(committed).toEqual(fundsTransferCapability());
  });
});

/** The Locator a named Step addresses, with its input references filled in. */
function locatorOf(stepId: string): Locator {
  const [base] = fundsTransferCapability().recordings;
  if (base === undefined || !("steps" in base)) throw new Error("no base Recording");

  const step = base.steps.find((candidate) => candidate.id === stepId);
  if (step === undefined) throw new Error(`no Step "${stepId}"`);
  if (!("locator" in step.action)) throw new Error(`Step "${stepId}" addresses no control`);

  return substituteLocator(step.action.locator, INPUTS);
}

/** Whether a Terminal State's predicate holds on one captured screen. */
function holdsOn(slug: string, name: "success" | "SOURCE_ON_HOLD" | "INSUFFICIENT_FUNDS"): boolean {
  const nodes = readAriaSnapshot(capturedMeridianTree(slug));
  return matchesPredicate(nodes, predicateOf(name), INPUTS);
}

/** One Terminal State's predicate, by name. */
function predicateOf(name: "success" | "SOURCE_ON_HOLD" | "INSUFFICIENT_FUNDS"): Predicate {
  const state = fundsTransferCapability().contract.terminalStates.find(
    (candidate) => (candidate.kind === "success" ? "success" : candidate.name) === name,
  );
  if (state === undefined) throw new Error(`no Terminal State "${name}"`);
  return state.when;
}
