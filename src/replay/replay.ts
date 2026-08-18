/**
 * Replay: running a Capability's Recording against a Surface with no model in
 * the decision loop.
 *
 * This is the production path, and the reason the rest of the system is shaped
 * the way it is. Everything a run needs is already decided before it starts —
 * which controls to address, what counts as having arrived, which values to
 * hand back — so there is nothing here to reason about and nothing to call.
 *
 * Two things it deliberately does not know about. It does not know how to log
 * in: a session is a property of the application rather than of any one
 * Capability, so the caller hands over a Surface that already has one (ADR
 * 0005 puts the same event, mid-run, in the Surface profile). And it does not
 * know an origin: the Recording stores paths, and `baseUrl` is the seam where
 * ticket 7's Surface profile will eventually supply one.
 */
import { resolveRecording } from "../capability/resolve-recording.js";
import type { Capability, TerminalState } from "../capability/schema.js";
import type { ActionResult, Surface } from "../surface/surface.js";
import { describeAction, describePredicate } from "./describe.js";
import { coerceTextValues, parseContractValues } from "./contract-values.js";
import { matchesPredicate } from "./predicate.js";
import { substituteAction, type ReplayInputs } from "./substitute.js";

export interface ReplayOptions {
  /**
   * The origin the Recording's paths hang off. Ticket 7's Surface profile owns
   * this; until then the caller supplies it, and the part that matters is
   * already true — the Recording does not carry one.
   */
  readonly baseUrl: string;
  /** Which Tenant's Recording to run. Absent means the shared one. */
  readonly variant?: string;
}

/**
 * How a run ended.
 *
 * A union rather than a return value plus exceptions, because ADR 0004 makes
 * ending a declared thing: a run reaches a Terminal State, or it stops and says
 * what it saw instead. Ticket 6 adds the third member — a named Business
 * Outcome — which is why this is a union of two today rather than a nullable
 * result.
 */
export type ReplayResult =
  | { readonly kind: "success"; readonly outputs: Record<string, unknown> }
  | {
      readonly kind: "hard-failure";
      /** The Step the run had reached. */
      readonly step: string;
      readonly expected: string;
      readonly observed: string;
      /** Where the Surface was when it stopped. */
      readonly url: string;
    };

export async function replayCapability(
  surface: Surface,
  capability: Capability,
  inputs: Readonly<Record<string, unknown>>,
  options: ReplayOptions,
): Promise<ReplayResult> {
  const ref = `${capability.id}@${capability.version}`;

  // Before the run starts, and before anything touches a screen: a Capability
  // that got halfway through a form and then discovered its inputs were wrong
  // would have left the application in a state nobody asked for.
  const values = parseContractValues(
    capability.contract.inputs,
    inputs,
    `This run's inputs for ${ref}`,
  );

  const steps = resolveRecording(capability, options.variant);
  const extracted: Record<string, string> = {};

  for (const step of steps) {
    const action = substituteAction(step.action, values, options.baseUrl);
    const result = await surface.perform(action);

    if (result.kind !== "ok") {
      return {
        kind: "hard-failure",
        step: step.id,
        expected: describeAction(action),
        observed: describeMiss(result),
        url: (await surface.snapshot()).url,
      };
    }

    // A `read` Step names the Contract output its value becomes, so extraction
    // is described by the Recording rather than by a second list of Locators
    // hanging off the Terminal State.
    if (step.action.kind === "read") extracted[step.action.bind] = result.value ?? "";
  }

  // The Steps running out is not success. ADR 0004: success is a declared
  // predicate over the accessibility tree, and this is the moment it is
  // actually checked rather than inferred.
  const success = successStateOf(capability);
  const snapshot = await surface.snapshot();
  if (!matchesPredicate(snapshot.nodes, success.when, values)) {
    return {
      kind: "hard-failure",
      // The last Step, which is as far as the run got. It is not the Step that
      // was wrong — every one of them succeeded — but it is where the run was
      // standing when it found itself somewhere it could not name.
      step: steps.at(-1)?.id ?? "",
      expected: describePredicate(success.when, values),
      observed: "no declared Terminal State matched the screen",
      url: snapshot.url,
    };
  }

  return {
    kind: "success",
    outputs: parseContractValues(
      capability.contract.outputs,
      // A read returns the text of a control; the Contract says what that text
      // means.
      coerceTextValues(capability.contract.outputs, extracted, `An output of ${ref}`),
      `This run's outputs for ${ref}`,
    ),
  };
}

function successStateOf(capability: Capability): Extract<TerminalState, { kind: "success" }> {
  const success = capability.contract.terminalStates.find((state) => state.kind === "success");
  if (success === undefined) {
    // The schema enforces exactly one, so reaching here means an unvalidated
    // Capability was built in code — a programming error, not a state of the
    // application.
    throw new Error(`Capability "${capability.id}@${capability.version}" declares no success state.`);
  }
  return success;
}

/**
 * A missed control as one phrase. Both misses are returned values rather than
 * thrown errors, and both are Hard Failures here: a Recording that cannot find
 * its control has nothing left to try, and one that finds several has no way to
 * know which the recorder meant.
 */
function describeMiss(result: Exclude<ActionResult, { kind: "ok" }>): string {
  return result.kind === "not-found"
    ? "no control matched"
    : `${result.matches} controls matched`;
}
