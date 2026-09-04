/**
 * Replay: running a Capability's Recording against a Surface with no model in
 * the decision loop.
 *
 * This is the production path, and the reason the rest of the system is shaped
 * the way it is. Everything a run needs is already decided before it starts —
 * which controls to address, what counts as having arrived, which values to
 * hand back — so there is nothing here to reason about and nothing to call.
 *
 * ADR 0005's three classes meet here, and this is the only place that decides
 * which one a screen is. A screen the Capability declares as an end is a
 * Terminal State: success, or a named Business Outcome the caller acts on. A
 * screen the Surface profile declares as an interruption is a Recoverable
 * Condition, absorbed rather than reported. Everything else is a Hard Failure
 * carrying the Step, what was expected, and what was observed — which is what
 * "an unmatched screen fails rather than assuming success" means in code.
 *
 * One thing it deliberately does not know about: how to log in. A session is a
 * property of the application rather than of any one Capability, so the caller
 * hands over a Surface that already has one — and hands over the means of
 * getting another, which is all `reestablishSession` is.
 */
import { resolveRecording } from "../capability/resolve-recording.js";
import { redactSessionIds } from "../evidence/redact-session-ids.js";
import type { Capability, Step, TerminalState } from "../capability/schema.js";
import type { RecoverableCondition } from "../policy/profile.js";
import type { Snapshot, Surface } from "../surface/surface.js";
import { describeAction, describeMiss, describePredicate } from "./describe.js";
import { coerceTextValues, parseContractValues } from "./contract-values.js";
import { matchesPredicate } from "./predicate.js";
import { substituteAction, type ReplayInputs } from "./substitute.js";

export interface ReplayOptions {
  /**
   * The origin the Recording's paths hang off. The Surface profile owns this;
   * the caller passes it separately because `--base-url` may override it, and
   * the profile's allowlist still governs what the gate lets through.
   */
  readonly baseUrl: string;
  /** Which Tenant's Recording to run. Absent means the shared one. */
  readonly variant?: string;
  /**
   * The Surface profile's declared Recoverable Conditions. Declared once per
   * installation rather than per Capability (ADR 0005): session expiry belongs
   * to ParaBank, not to any one thing being done to it.
   */
  readonly recoverableConditions?: readonly RecoverableCondition[];
  /**
   * How to answer a condition that asks for one. Credentials are a Secret (ADR
   * 0006) and no checked-in profile holds them, so the profile says a condition
   * needs a session re-established and the caller supplies the doing.
   *
   * Absent means a matched condition is reported rather than absorbed — a Hard
   * Failure that names the condition, which is more use than a run silently
   * failing to recognise a screen it can in fact name.
   */
  reestablishSession?(): Promise<void>;
  /** How many times one run may absorb a condition. Defaults to two. */
  readonly maxRecoveries?: number;
}

/**
 * A run that kept meeting the same interruption is not recovering, it is
 * looping. Two, because a session expiring once mid-run is ordinary and a
 * second one is bad luck, but a run still being interrupted after it has twice
 * re-established a session is not making progress and should say so.
 */
const DEFAULT_MAX_RECOVERIES = 2;

/**
 * How a run ended.
 *
 * A union rather than a return value plus exceptions, because ADR 0004 and ADR
 * 0005 both make ending a declared thing: a run reaches a Terminal State, or it
 * stops and says what it saw instead. A Business Outcome sits alongside success
 * rather than under failure — "no such account" is the application working
 * correctly, and a caller reads which outcome it was rather than catching it.
 */
export type ReplayResult =
  | { readonly kind: "success"; readonly outputs: Record<string, unknown> }
  | {
      readonly kind: "business-outcome";
      /** As the Contract declares it: `ACCOUNT_NOT_FOUND`. */
      readonly name: string;
      /**
       * Where the run was standing when the outcome was recognised. No outputs:
       * the Contract's outputs describe success, and a run that ended anywhere
       * else did not read them.
       */
      readonly step: string;
    }
  | {
      readonly kind: "hard-failure";
      /** The Step the run had reached. */
      readonly step: string;
      readonly expected: string;
      readonly observed: string;
      /**
       * Where the Surface was when it stopped, with any session token masked.
       * ParaBank carries one in the URL, ADR 0006 classes it a Secret, and a
       * failure report is the one value on this path that gets printed and
       * logged.
       */
      readonly url: string;
    };

type HardFailure = Extract<ReplayResult, { kind: "hard-failure" }>;

/**
 * One pass over the Recording either ended, or was interrupted by something the
 * profile says is not an ending at all.
 *
 * The interruption carries the Hard Failure it would otherwise have been, so
 * that a condition nobody can absorb reports the screen the run was actually
 * standing on rather than a second, vaguer description of it.
 */
type Attempt =
  | ReplayResult
  | {
      readonly kind: "interrupted";
      readonly condition: RecoverableCondition;
      readonly failure: HardFailure;
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

  for (let recovered = 0; ; recovered += 1) {
    const attempt = await runOnce(surface, capability, steps, values, options, ref);
    if (attempt.kind !== "interrupted") return attempt;

    const refusal = whyNotAbsorbed(capability, attempt.condition, recovered, options);
    if (refusal !== undefined) {
      return { ...attempt.failure, observed: `${attempt.failure.observed}; ${refusal}` };
    }

    // Absorbed, and then the whole Recording runs again from its first Step.
    // Re-running rather than resuming, because the screen the run was left
    // standing on is not one any Step expected to be on. A `re-establish-session`
    // condition means the old session is gone, so a new one is signed in first;
    // a `retry` condition (MERIDIAN's transient maintenance page) leaves the
    // session intact, so the run is simply attempted again.
    if (attempt.condition.recover === "re-establish-session") {
      await options.reestablishSession?.();
    }
  }
}

/**
 * Why this interruption is being reported rather than absorbed.
 *
 * The mutating rule is the one worth reading twice. Absorbing a condition means
 * re-running the Recording from Step one, and a Recording that transfers money
 * run twice transfers it twice. ADR 0007 already has each Capability declare
 * its effects statically, so the decision is made from a checked-in field
 * rather than from anything observed mid-run.
 */
function whyNotAbsorbed(
  capability: Capability,
  condition: RecoverableCondition,
  recovered: number,
  options: ReplayOptions,
): string | undefined {
  const met = `the "${condition.name}" Recoverable Condition matched`;

  // Only re-establishing needs credentials the caller may not have handed over;
  // a `retry` condition is absorbed with nothing but another pass.
  if (condition.recover === "re-establish-session" && options.reestablishSession === undefined) {
    return `${met}, and this run was given no way to re-establish a session`;
  }
  if (capability.contract.effects !== "read-only") {
    return `${met}, and a mutating Capability is not re-run from the start`;
  }

  const budget = options.maxRecoveries ?? DEFAULT_MAX_RECOVERIES;
  if (recovered >= budget) {
    return `${met} again, and this run may absorb ${budget === 0 ? "none" : `only ${budget}`}`;
  }
  return undefined;
}

/** One pass over the Recording, from its first Step. */
async function runOnce(
  surface: Surface,
  capability: Capability,
  steps: readonly Step[],
  values: ReplayInputs,
  options: ReplayOptions,
  ref: string,
): Promise<Attempt> {
  const extracted: Record<string, string> = {};
  // A `readEach` binds a structured list, not a scalar, so it is kept apart from
  // the text reads: `coerceTextValues` turns text into a declared type and would
  // reject an array, which this list already is.
  const extractedRecords: Record<string, unknown> = {};

  for (const step of steps) {
    const action = substituteAction(step.action, values, options.baseUrl);
    const result = await surface.perform(action);

    if (result.kind !== "ok") {
      const at = {
        step: step.id,
        expected: describeAction(action),
        observed: describeMiss(result),
      };

      // A refusal is the only miss that says nothing about the screen. The
      // Action never reached the application, so what is on display was not
      // produced by it and must not be read as this Capability's answer or as
      // something to recover from and try again — the gate that refused once
      // refuses the same Step on a second pass. It is a Hard Failure carrying
      // the gate's reason, which is what ADR 0007 escalates on.
      if (result.kind === "refused") {
        return { kind: "hard-failure", ...at, url: redactSessionIds((await surface.snapshot()).url) };
      }

      // Any other miss is not yet a failure. What the screen it missed on turns
      // out to be is what decides which of ADR 0005's three classes this is —
      // and for the lookup Capability it is where a genuinely absent account
      // becomes ACCOUNT_NOT_FOUND rather than an unfound link.
      return interpret(await surface.snapshot(), capability, values, options, at);
    }

    // A `read` Step names the Contract output its value becomes, so extraction
    // is described by the Recording rather than by a second list of Locators
    // hanging off the Terminal State.
    if (step.action.kind === "read") extracted[step.action.bind] = result.value ?? "";
    // A `readEach` binds the whole list of rows. An empty list is a real value —
    // a table with no data rows — so it is bound as `[]`, not skipped.
    if (step.action.kind === "readEach") extractedRecords[step.action.bind] = result.records ?? [];
  }

  // The Steps running out is not success. ADR 0004: success is a declared
  // predicate over the accessibility tree, and this is the moment it is
  // actually checked rather than inferred.
  const success = successStateOf(capability);
  const snapshot = await surface.snapshot();
  if (!matchesPredicate(snapshot.nodes, success.when, values)) {
    return interpret(snapshot, capability, values, options, {
      // The last Step, which is as far as the run got. It is not the Step that
      // was wrong — every one of them succeeded — but it is where the run was
      // standing when it found itself somewhere it could not name.
      step: steps.at(-1)?.id ?? "",
      expected: describePredicate(success.when, values),
      observed: "no declared Terminal State matched",
    });
  }

  return {
    kind: "success",
    outputs: parseContractValues(
      capability.contract.outputs,
      // A read returns the text of a control; the Contract says what that text
      // means. A `readEach` already produced structured rows, so those join the
      // coerced scalars rather than passing through the text coercion.
      {
        ...coerceTextValues(capability.contract.outputs, extracted, `An output of ${ref}`),
        ...extractedRecords,
      },
      `This run's outputs for ${ref}`,
    ),
  };
}

/**
 * What the screen the run is standing on actually is.
 *
 * The order is the argument. A Recoverable Condition is asked about first
 * because it says the application is in the way — the login screen instead of
 * what was asked for — and a screen that is nobody's answer must not be read as
 * one. Only then are the Capability's own declared endings considered, and only
 * a screen matching neither is a Hard Failure.
 */
function interpret(
  snapshot: Snapshot,
  capability: Capability,
  values: ReplayInputs,
  options: ReplayOptions,
  at: { readonly step: string; readonly expected: string; readonly observed: string },
): Attempt {
  const failure: HardFailure = { kind: "hard-failure", ...at, url: redactSessionIds(snapshot.url) };

  const condition = options.recoverableConditions?.find((candidate) =>
    matchesPredicate(snapshot.nodes, candidate.when, values),
  );
  if (condition !== undefined) return { kind: "interrupted", condition, failure };

  for (const state of capability.contract.terminalStates) {
    if (state.kind !== "business-outcome") continue;
    if (!matchesPredicate(snapshot.nodes, state.when, values)) continue;
    return { kind: "business-outcome", name: state.name, step: at.step };
  }

  return failure;
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
