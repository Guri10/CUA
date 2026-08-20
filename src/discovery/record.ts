/**
 * The recorder: a Discovery Run turned into a Capability.
 *
 * It is a pure function over the Actions a run took — no model, no Surface, no
 * clock — which is why the spec draws the tested boundary here. The model's
 * decisions are non-deterministic and asserting on them tests Anthropic; what
 * happens to those decisions afterwards is fixed, and this is that.
 *
 * ADR 0002 made the tool verbs identical to the Step vocabulary so that this
 * would be a filter rather than a translation, and it is: every Step below is
 * an Action the run actually performed, with three things done to it. Failed
 * Actions are dropped. Repeats are collapsed. Concrete values become references
 * into the Contract's inputs, which is what lets the Recording serve any
 * account rather than the one it was recorded against.
 *
 * What it deliberately does not do is invent a Contract. A run is handed the
 * inputs it may use and the values it must return, and the Contract is built
 * from those — user story 13, "the Contract is a deliberate decision rather
 * than whatever the recording happened to scrape". The one part derived from
 * the run itself is the success Terminal State, because only the run knows
 * which controls it ended up standing in front of.
 *
 * **A detour that worked is still recorded.** Dropping the Actions that failed
 * removes the searching a run did; it does not remove a wrong turn the run took
 * successfully and then walked back from. Nothing in a list of Actions says
 * which screen each one led to, so there is no honest way to tell a detour from
 * a step of the flow, and inventing one would silently delete Steps a Recording
 * needs. What that leaves is a Recording that is longer than it has to be but
 * still correct, and an operator who reads the Steps before approving them —
 * which is what the printed run and the draft status are for.
 *
 * **It cannot record a Business Outcome.** A run that succeeded never saw the
 * not-found screen, so there is nothing to derive one from, and ADR 0004 is
 * explicit that an unanticipated ending must surface as a Hard Failure rather
 * than be guessed at. A recorded Capability therefore declares success and
 * nothing else, and lands as a draft for a person to add the rest — which is
 * the same reason `approval` is never set here.
 */
import { z } from "zod";
import { jsonSchemaFor } from "../capability/json-schema.js";
import {
  BASE_VARIANT,
  capabilitySchema,
  inputReferencesInAction,
  type Capability,
  type Expression,
  type Predicate,
  type Step,
  type StepAction,
  type StepLocator,
  type TerminalState,
} from "../capability/schema.js";
import type { Locator } from "../surface/surface.js";
import type { TakenStep } from "./discover.js";

/**
 * Everything a Discovery Run cannot work out for itself.
 *
 * The run knows how to reach the balance; it does not know what the Capability
 * should be called, which of the strings it typed were the caller's to supply,
 * or what a caller is entitled to get back. Those are the operator's, declared
 * before the run rather than reverse-engineered after it.
 */
export interface RecordingPlan {
  readonly id: string;
  /** One per Discovery Run that changes the Steps. The caller picks the next. */
  readonly version: number;
  /** Which Surface profile the run was pointed at. */
  readonly surface: string;
  /** One line for a catalog listing — in practice the goal, as it was typed. */
  readonly summary: string;
  readonly effects: "read-only" | "mutating";
  /**
   * The origin the run was pointed at, stripped off every navigate Step.
   * A Recording carrying an origin would run against one installation only.
   */
  readonly baseUrl: string;
  /**
   * The concrete values the run was given, by input name. Every occurrence of
   * one becomes a reference, and an input the run never used is refused rather
   * than recorded — a Contract declaring an input no Step reads is a Capability
   * that ignores what its caller asked for.
   */
  readonly inputs: Readonly<Record<string, string>>;
  /** What the caller gets back. Each must be bound by a read the run performed. */
  readonly outputs: readonly string[];
}

/**
 * Either a Capability, or the reasons there isn't one.
 *
 * A union rather than a throw, for the reason ADR 0005 gives everywhere else: a
 * run that reached its goal without reading the value it was asked for is an
 * ordinary outcome of pointing a model at an application, not a defect. The
 * operator needs to read what was missing and run it again.
 *
 * Every reason at once rather than the first, because the second run should not
 * be the one that discovers the second problem.
 */
export type RecordingResult =
  | { readonly kind: "recorded"; readonly capability: Capability }
  | { readonly kind: "unrecordable"; readonly reasons: readonly string[] };

export function recordCapability(plan: RecordingPlan, taken: readonly TakenStep[]): RecordingResult {
  const kept = keptSteps(taken, plan.outputs);
  const reasons = [...ambiguousInputs(plan), ...foreignAddresses(plan, kept)];

  const identified = withStepIds(kept.map((step) => stepActionFor(step, plan)));

  reasons.push(...unusedInputs(plan, identified));
  reasons.push(...unreadOutputs(plan, identified));

  const success = successState(identified);
  if (success === undefined) {
    reasons.push(
      "The run neither read a value nor waited for a control, so there is nothing " +
        "it could declare as having succeeded.",
    );
  }

  if (reasons.length > 0 || success === undefined) return { kind: "unrecordable", reasons };

  // Parsed rather than cast. This file is written unattended and the schema
  // holds every rule that makes a Capability runnable rather than merely
  // well-formed, so the recorder answers to it here rather than leaving the
  // first failure to whoever next tries to replay.
  const parsed = capabilitySchema.safeParse({
    id: plan.id,
    version: plan.version,
    surface: plan.surface,
    // Never anything else. A Capability the recorder approved would be a
    // Capability approved by the thing that wrote it.
    approval: "draft",
    contract: {
      summary: plan.summary,
      inputs: textSchemaFor(Object.keys(plan.inputs)),
      outputs: textSchemaFor(plan.outputs),
      effects: plan.effects,
      terminalStates: [success],
    },
    recordings: [{ variant: BASE_VARIANT, steps: identified }],
  });

  if (!parsed.success) {
    return {
      kind: "unrecordable",
      reasons: parsed.error.issues.map(
        (issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`,
      ),
    };
  }

  return { kind: "recorded", capability: parsed.data };
}

/**
 * The Actions worth keeping, in the order they happened.
 *
 * Three filters, and each of them is one of the ways a Discovery Run differs
 * from the flow it discovered.
 */
function keptSteps(taken: readonly TakenStep[], outputs: readonly string[]): TakenStep[] {
  // A dead end: the control was not there, or there were several of it, or the
  // gate refused. The run learned something from it; the Recording does not
  // need it, and replaying it would fail in exactly the same way.
  const succeeded = taken.filter((step) => step.result.kind === "ok");

  // A read is in the Recording to produce a declared value. One that binds
  // nothing was the model looking around, and at replay time it would address a
  // control, take its text, and drop it. Where the same value was read twice,
  // the last read is the one the run reported.
  const declared = new Set(outputs);
  const lastReadFor = new Map<string, TakenStep>();
  for (const step of succeeded) {
    if (step.action.kind !== "read") continue;
    if (step.bind === undefined || !declared.has(step.bind)) continue;
    lastReadFor.set(step.bind, step);
  }
  const bound = new Set(lastReadFor.values());
  const useful = succeeded.filter((step) => step.action.kind !== "read" || bound.has(step));

  return withoutSupersededSteps(useful);
}

/**
 * A retry, among the Actions that worked: the same thing done twice to the same
 * control without the screen having moved in between. The model typed a value,
 * thought better of it, and typed another; or it waited for the same control
 * twice while a page loaded. Only the last of each survives.
 *
 * Bounded by the Actions that can move the screen — a navigate or a click —
 * because the same wait on either side of one is two different screens
 * answering to the same description, and collapsing those would drop a
 * checkpoint the flow genuinely needs.
 *
 * A click is never collapsed into another click. Two clicks on one control may
 * be a stutter or may be two screens that look alike, the run cannot tell them
 * apart, and a Recording with a redundant click still works where one missing a
 * click does not.
 */
function withoutSupersededSteps(steps: readonly TakenStep[]): TakenStep[] {
  const kept: TakenStep[] = [];
  let seen = new Set<string>();

  // Backwards, because it is the last of a run of repeats that stands.
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    const step = steps[index]!;
    const action = step.action;

    if (action.kind === "fill" || action.kind === "select" || action.kind === "waitFor") {
      // The value is deliberately not part of the key: a second fill of one box
      // is a correction, and it is the correction that gets recorded.
      const key = `${action.kind}:${JSON.stringify(action.locator)}`;
      if (seen.has(key)) continue;
      seen.add(key);
    }

    kept.push(step);
    if (action.kind === "navigate" || action.kind === "click") seen = new Set();
  }

  return kept.reverse();
}

/** One Action as the Step form of itself, with concrete values parameterised. */
function stepActionFor(step: TakenStep, plan: RecordingPlan): StepAction {
  const action = step.action;

  switch (action.kind) {
    case "navigate":
      return { kind: "navigate", url: expressionFor(pathOf(action.url, plan), plan) };

    case "click":
      return { kind: "click", locator: stepLocatorFor(action.locator, plan) };

    case "fill":
      return {
        kind: "fill",
        locator: stepLocatorFor(action.locator, plan),
        value: expressionFor(action.value, plan),
      };

    case "select":
      return {
        kind: "select",
        locator: stepLocatorFor(action.locator, plan),
        option: expressionFor(action.option, plan),
      };

    case "read":
      return {
        kind: "read",
        locator: stepLocatorFor(action.locator, plan),
        // `keptSteps` drops every read without one, so this is a formality the
        // type system needs rather than a case that happens.
        bind: step.bind ?? "",
      };

    case "waitFor":
      return {
        kind: "waitFor",
        locator: stepLocatorFor(action.locator, plan),
        ...(action.timeoutMs === undefined ? {} : { timeoutMs: action.timeoutMs }),
      };
  }
}

function stepLocatorFor(locator: Locator, plan: RecordingPlan): StepLocator {
  return {
    role: locator.role,
    ...(locator.name === undefined ? {} : { name: expressionFor(locator.name, plan) }),
    ...(locator.exact === undefined ? {} : { exact: locator.exact }),
    ...(locator.ordinal === undefined ? {} : { ordinal: locator.ordinal }),
    ...(locator.within === undefined ? {} : { within: stepLocatorFor(locator.within, plan) }),
  };
}

/**
 * The parameterisation, and it is whole-value equality rather than substring
 * replacement.
 *
 * Substring replacement reads as the more helpful rule and is the one that
 * corrupts a Recording quietly: an account id of "1" would rewrite the "1" in
 * "$1,231.10", in "Bill Pay", in a URL path. Whole-value equality either
 * recognises the caller's value or does not, and when it does not the run is
 * refused rather than half-parameterised — see `unusedInputs`.
 */
function expressionFor(text: string, plan: RecordingPlan): Expression {
  for (const [name, value] of Object.entries(plan.inputs)) {
    if (value === text) return { kind: "input", input: name };
  }
  return { kind: "literal", value: text };
}

/**
 * The path a navigate Step stores, with the installation's origin taken off.
 *
 * A URL from somewhere else has no path to give, and comes back unchanged. That
 * is never written: `foreignAddresses` has already refused the whole recording
 * over it, for the same reason `substituteAction` refuses one on the way back —
 * a Recording carrying a whole URL runs against exactly one installation.
 */
function pathOf(url: string, plan: RecordingPlan): string {
  const base = originOf(plan);
  if (url === base) return "/";
  return url.startsWith(`${base}/`) ? url.slice(base.length) : url;
}

/** Where the run was pointed, with any trailing slash off so concatenation is safe. */
function originOf(plan: RecordingPlan): string {
  return plan.baseUrl.replace(/\/+$/, "");
}

/**
 * Anywhere the run went that was not the installation it was pointed at.
 *
 * The origin belongs to the Surface profile, so there is nothing a Recording
 * could store for one of these that would mean the same thing at another site.
 * Refused rather than stored whole.
 */
function foreignAddresses(plan: RecordingPlan, steps: readonly TakenStep[]): string[] {
  const base = originOf(plan);

  return steps.flatMap((step) => {
    if (step.action.kind !== "navigate") return [];
    const url = step.action.url;
    // Unchanged by `pathOf` means it had no path to give: it is not under the
    // origin the run was pointed at.
    if (pathOf(url, plan) !== url) return [];
    return [
      `The run went to ${url}, which is not under ${base}, so there is no path to record — ` +
        "the origin belongs to the Surface profile.",
    ];
  });
}

/**
 * Stable ids, assigned here because a Step needs one the moment it exists: a
 * variant patch and a failure report both name a Step, and neither may be
 * disturbed by a later Recording inserting something above it.
 *
 * Derived from what the Step does rather than from where it sits, so the same
 * Actions always yield the same ids. A collision takes a numeric suffix, which
 * is the one place position leaks in — two Steps doing the same thing to the
 * same control are only told apart by which came first.
 */
function withStepIds(actions: readonly StepAction[]): Step[] {
  const used = new Map<string, number>();

  return actions.map((action) => {
    const base = describeForId(action);
    const seen = used.get(base) ?? 0;
    used.set(base, seen + 1);
    return { id: seen === 0 ? base : `${base}-${seen + 1}`, action };
  });
}

function describeForId(action: StepAction): string {
  switch (action.kind) {
    case "navigate":
      // The path, so that a Recording with two navigates reads as two places
      // rather than as `navigate` and `navigate-2`.
      return slug(`navigate ${action.url.kind === "literal" ? action.url.value : "input"}`);

    case "read":
      // The value it produces. `read-balance` is the name anybody debugging a
      // failure would have picked.
      return slug(`read ${action.bind}`);

    default: {
      // Role and name, and the name only when it is a literal: a reference
      // resolves to a different string on every run, so an id built from one
      // would be a lie about what the Step addresses.
      const name = action.locator.name;
      const parts: string[] = [action.kind, action.locator.role];
      if (name?.kind === "literal") parts.push(name.value);
      return slug(parts.join(" "));
    }
  }
}

/**
 * A Step id, which is also a key in a variant patch: lower-kebab, and nothing
 * else. `waitFor` becomes `wait-for`, `accountType` becomes `account-type`, and
 * a name made entirely of punctuation — ParaBank's `$` rows — contributes
 * nothing rather than an empty segment.
 */
function slug(text: string): string {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * What the Capability declares as having succeeded, derived from the run.
 *
 * The controls the declared values were read from, all of them present. That is
 * the strongest claim the run supports and the one that means something: if
 * those controls are on the screen, the outputs can be extracted, and if they
 * are not, the run has not arrived wherever it was going.
 *
 * A Capability that returns nothing has no such controls, and falls back to the
 * last thing it waited for — the checkpoint the model chose as "I have arrived".
 * The last one rather than all of them, because the earlier waits were for
 * screens the run has since left.
 *
 * It is deliberately weaker than a hand-written Terminal State, which can also
 * say that a value has arrived rather than merely that its cell exists. The
 * recorder has no way to know that, which is another reason the file lands as a
 * draft.
 */
function successState(steps: readonly Step[]): TerminalState | undefined {
  const reads = steps.filter((step) => step.action.kind === "read");
  const onScreen: Predicate[] = reads.map((step) => ({
    kind: "present",
    locator: (step.action as Extract<StepAction, { kind: "read" }>).locator,
  }));

  if (onScreen.length === 0) {
    const waits = steps.filter((step) => step.action.kind === "waitFor");
    const waited = waits.at(-1);
    if (waited === undefined) return undefined;
    onScreen.push({
      kind: "present",
      locator: (waited.action as Extract<StepAction, { kind: "waitFor" }>).locator,
    });
  }

  return { kind: "success", when: { kind: "all", of: onScreen } };
}

/**
 * Two inputs with the same value, which the recorder cannot tell apart.
 *
 * It would have to pick one, and picking is how a Recording ends up filling the
 * payee field from the amount. Refused instead: run discovery again with values
 * that differ.
 */
function ambiguousInputs(plan: RecordingPlan): string[] {
  const byValue = new Map<string, string[]>();
  for (const [name, value] of Object.entries(plan.inputs)) {
    byValue.set(value, [...(byValue.get(value) ?? []), name]);
  }

  return [...byValue.entries()]
    .filter(([, names]) => names.length > 1)
    .map(
      ([, names]) =>
        `Inputs ${names.map((name) => `"${name}"`).join(" and ")} were given the same value, ` +
        "so a Step using it could refer to either. Use values that differ.",
    );
}

/**
 * An input the run never used.
 *
 * The quietest way this system could be wrong: the Contract asks the caller for
 * an account number, no Step refers to it, and every replay returns the balance
 * of whichever account the run happened to be recorded against. The schema does
 * not catch it — a Recording referring to fewer inputs than the Contract
 * declares is well-formed — so it is caught here.
 */
function unusedInputs(plan: RecordingPlan, steps: readonly Step[]): string[] {
  const referenced = new Set(steps.flatMap((step) => inputReferencesInAction(step.action)));

  return Object.entries(plan.inputs)
    .filter(([name]) => !referenced.has(name))
    .map(
      ([name, value]) =>
        `No Step used input "${name}", so the Recording would ignore whatever a caller supplies ` +
        `for it. The run was given "${value}" — check it addressed a control by that value ` +
        "rather than by position.",
    );
}

/**
 * A declared value the run never read. The Contract would promise it and return
 * nothing.
 *
 * The schema refuses this too, and says so in the vocabulary of a Capability
 * file: "the Contract declares output X, which no Step in the base Recording
 * reads". Said here as well because the person reading it did not write a
 * Recording — they pointed a model at an application, and what they need to be
 * told is which of the two things to change.
 */
function unreadOutputs(plan: RecordingPlan, steps: readonly Step[]): string[] {
  const bound = new Set(
    steps.flatMap((step) => (step.action.kind === "read" ? [step.action.bind] : [])),
  );

  return plan.outputs
    .filter((output) => !bound.has(output))
    .map(
      (output) =>
        `The run never read a value for "${output}". Seeing a value on the screen is not ` +
        "reading it — the run has to take it with the read tool for it to be recorded.",
    );
}

/**
 * The Contract's input and output schema, generated from Zod like every other
 * one so that a Capability the recorder wrote and one written by hand publish
 * the same shape.
 *
 * Every declared value is a string, and that is not a placeholder. Everything an
 * Expression feeds is text — an accessible name, what gets typed into a box —
 * and what a read returns is the text a control displays. A Contract claiming a
 * number would be claiming a conversion nobody performed.
 */
function textSchemaFor(names: readonly string[]) {
  return jsonSchemaFor(z.object(Object.fromEntries(names.map((name) => [name, z.string()]))));
}
