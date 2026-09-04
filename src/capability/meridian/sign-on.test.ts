import { describe, expect, it } from "vitest";
import { readAriaSnapshot } from "../../surface/aria-snapshot.js";
import { resolveLocator } from "../../surface/resolve-locator.js";
import { FakeSurface } from "../../surface/fake-surface.js";
import {
  capturedMeridianTree,
  meridianScript,
  MERIDIAN_CAPTURED_BASE_URL as BASE,
} from "../../surface/meridian/fake-script.js";
import type { Locator } from "../../surface/surface.js";
import { substituteLocator } from "../../replay/substitute.js";
import { loadSurfaceProfile, surfacesDir } from "../../policy/profile.js";
import { replayCapability } from "../../replay/replay.js";
import { capabilitySchema, type StepLocator } from "../schema.js";
import { jsonSchemaFor } from "../json-schema.js";
import { capabilitiesDir, loadCapability } from "../storage.js";
import { signOnCapability, signOnInputs, signOnOutputs } from "./sign-on.js";

/**
 * The MERIDIAN sign-on Capability, checked against the trees MERIDIAN actually
 * served and replayed end-to-end against the fake.
 *
 * The Capability shares its flow with `logInToMeridian` — session establishment
 * and §2.1 coverage are the same six Actions — so what is proven here is that
 * the flow is a valid Capability, that its Locators address real controls, and
 * that Replay reads its two endings correctly: the menu is success, the sign-on
 * screen it was turned back to is BAD_LOGIN.
 */
const INPUTS = {
  operator: "teller1",
  password: "a-password",
  branch: "MAIN-001 - Main Office",
} as const;

describe("the MERIDIAN sign-on Capability", () => {
  it("validates against the Capability schema", () => {
    expect(capabilitySchema.safeParse(signOnCapability()).success).toBe(true);
  });

  it("publishes the JSON Schema Zod generates for its inputs and outputs", () => {
    const { contract } = signOnCapability();

    expect(contract.inputs).toEqual(jsonSchemaFor(signOnInputs));
    expect(contract.outputs).toEqual(jsonSchemaFor(signOnOutputs));
  });

  it("addresses the operator, password, branch, and button on the captured sign-on screen", () => {
    const signon = readAriaSnapshot(capturedMeridianTree("signon"));

    for (const stepId of ["fill-operator", "fill-password", "choose-branch", "sign-on"]) {
      expect(resolveLocator(signon, locatorOf(stepId))).toHaveLength(1);
    }
  });

  it("matches success only on the menu, and BAD_LOGIN only on the sign-on screen", () => {
    const menu = readAriaSnapshot(capturedMeridianTree("menu"));
    const signon = readAriaSnapshot(capturedMeridianTree("signon"));

    expect(resolveLocator(menu, terminalLocator("success"))).toHaveLength(1);
    expect(resolveLocator(signon, terminalLocator("success"))).toHaveLength(0);

    expect(resolveLocator(signon, terminalLocator("BAD_LOGIN"))).toHaveLength(1);
    expect(resolveLocator(menu, terminalLocator("BAD_LOGIN"))).toHaveLength(0);
  });

  it("replays to success against the fake", async () => {
    const surface = new FakeSurface(meridianScript("succeeds"));

    const result = await replayCapability(surface, signOnCapability(), INPUTS, {
      baseUrl: BASE,
    });

    // Empty outputs by design: success is the menu it reached, and the operator
    // role a caller wants is read by session establishment, not here.
    expect(result).toEqual({ kind: "success", outputs: {} });
  });

  it("reports BAD_LOGIN when the credentials are turned back", async () => {
    // The rejected script leaves the run on the sign-on screen — where a
    // turned-back operator actually stands. The Business Outcome is a predicate
    // over that screen, not a caught error.
    const surface = new FakeSurface(meridianScript("rejected"));

    const result = await replayCapability(surface, signOnCapability(), INPUTS, {
      baseUrl: BASE,
      // Passed so the realistic order is exercised: a Recoverable Condition is
      // asked about before a Business Outcome, and neither MERIDIAN condition
      // must swallow the sign-on screen.
      recoverableConditions: (await loadSurfaceProfile(surfacesDir(), "meridian"))
        .recoverableConditions,
    });

    expect(result).toEqual({ kind: "business-outcome", name: "BAD_LOGIN", step: "wait-for-menu" });
  });

  it("is committed as the file a caller actually reads", async () => {
    const committed = await loadCapability(capabilitiesDir(), "sign-on", 1);

    expect(committed).toEqual(signOnCapability());
  });
});

/** The Locator a named Step addresses, with its input references filled in. */
function locatorOf(stepId: string): Locator {
  const [base] = signOnCapability().recordings;
  if (base === undefined || !("steps" in base)) throw new Error("no base Recording");

  const step = base.steps.find((candidate) => candidate.id === stepId);
  if (step === undefined) throw new Error(`no Step "${stepId}"`);
  if (!("locator" in step.action)) throw new Error(`Step "${stepId}" addresses no control`);

  return substituteLocator(step.action.locator, INPUTS);
}

/** The single Locator a Terminal State's predicate rests on. */
function terminalLocator(name: "success" | "BAD_LOGIN"): Locator {
  const state = signOnCapability().contract.terminalStates.find(
    (candidate) => (candidate.kind === "success" ? "success" : candidate.name) === name,
  );
  if (state === undefined || state.when.kind !== "present") {
    throw new Error(`no simple Terminal State "${name}"`);
  }
  return substituteLocator(state.when.locator as StepLocator, INPUTS);
}
