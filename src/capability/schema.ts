/**
 * The Capability, declared once in Zod.
 *
 * One declaration yields three things that would otherwise drift apart: the
 * static types the rest of the codebase programs against, the runtime
 * validation a file read off disk goes through, and — for the input and output
 * declarations — the JSON Schema published in the Contract so that a calling
 * agent can read it without importing any code.
 *
 * The structural rules ADR 0004 and the spec put on a Capability are enforced
 * here rather than by convention: exactly one `success` Terminal State, Step
 * ids unique and stable, a variant patch that names a Step the base actually
 * has, and a Recording whose input references and output bindings match the
 * Contract that declares them. Everything downstream can then read a loaded
 * Capability without re-checking it.
 */
import { z } from "zod";
import { ARIA_ROLES } from "../surface/aria-roles.js";

/** Lower-kebab, so that an id is also a directory name and a URL segment. */
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** A property name in the Contract's input or output schema. */
const PROPERTY_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** A Business Outcome reads as a constant at a call site: `ACCOUNT_NOT_FOUND`. */
const OUTCOME_NAME = /^[A-Z][A-Z0-9_]*$/;

/** The variant name of the Recording every other variant is a patch against. */
export const BASE_VARIANT = "base";

/**
 * A Step value, per the spec: either a literal or a reference into the inputs.
 *
 * This is what makes a Recording work for any account rather than the one it
 * was recorded against. It is deliberately not a template string with braces in
 * it — a reference is a node the recorder produces and the executor resolves,
 * with no parsing in between and no escaping rule to get wrong.
 */
export const expressionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("literal"), value: z.string() }),
  z.object({ kind: z.literal("input"), input: z.string().regex(PROPERTY_NAME) }),
]);

export type Expression = z.infer<typeof expressionSchema>;

/**
 * A Locator as a Recording stores it: the `Locator` of ADR 0001 with its
 * accessible name left as an Expression. Resolving the Expression against a
 * run's inputs is what turns it into the `Locator` the Surface takes.
 */
export const stepLocatorSchema = z.object({
  role: z.enum(ARIA_ROLES),
  name: expressionSchema.optional(),
  exact: z.boolean().optional(),
  ordinal: z.int().nonnegative().optional(),
  get within() {
    return stepLocatorSchema.optional();
  },
});

export type StepLocator = z.infer<typeof stepLocatorSchema>;

/**
 * A condition over the accessibility tree, in the ADR 0001 vocabulary and
 * nothing else. `absent` is not decoration: "this account does not exist" is
 * "the overview is on screen and carries no link with that number", which is a
 * predicate over the tree rather than an error to catch.
 *
 * `any` is here for the trap the accessibility survey found: an application
 * that shows the same empty-result screen in more than one rendering. A
 * Business Outcome that can only be written as a conjunction would be worked
 * around by declaring it twice under two names, which is worse.
 */
export type Predicate =
  | { kind: "present"; locator: StepLocator }
  | { kind: "absent"; locator: StepLocator }
  | { kind: "all"; of: Predicate[] }
  | { kind: "any"; of: Predicate[] };

export const predicateSchema: z.ZodType<Predicate> = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("present"), locator: stepLocatorSchema }),
  z.object({ kind: z.literal("absent"), locator: stepLocatorSchema }),
  z.object({
    kind: z.literal("all"),
    get of() {
      return z.array(predicateSchema).min(1);
    },
  }),
  z.object({
    kind: z.literal("any"),
    get of() {
      return z.array(predicateSchema).min(1);
    },
  }),
]);

/**
 * What one Step does. The verbs are the `Action` verbs of the Surface seam
 * exactly, so that turning a Discovery Run into a Recording is a filter over
 * successful Actions rather than a translation.
 *
 * The one addition is `bind` on a read: the name of the Contract output the
 * value it returns becomes. Extraction is therefore described by the Recording
 * — the single description of what happened — and the Contract declares the
 * shape those values must satisfy.
 */
export const stepActionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("navigate"), url: expressionSchema }),
  z.object({ kind: z.literal("click"), locator: stepLocatorSchema }),
  z.object({ kind: z.literal("fill"), locator: stepLocatorSchema, value: expressionSchema }),
  z.object({ kind: z.literal("select"), locator: stepLocatorSchema, option: expressionSchema }),
  z.object({
    kind: z.literal("read"),
    locator: stepLocatorSchema,
    bind: z.string().regex(PROPERTY_NAME),
  }),
  z.object({
    kind: z.literal("waitFor"),
    locator: stepLocatorSchema,
    timeoutMs: z.int().positive().optional(),
  }),
]);

export type StepAction = z.infer<typeof stepActionSchema>;

/**
 * One Step, carrying a stable id so that variant overrides and failure reports
 * refer to it independently of its position in the list.
 */
export const stepSchema = z.object({
  id: z.string().regex(SLUG),
  action: stepActionSchema,
});

export type Step = z.infer<typeof stepSchema>;

/**
 * A Terminal State, per ADR 0004. Success carries no name because there is
 * exactly one of it; a Business Outcome is named because the caller acts on
 * which one it was.
 */
export const terminalStateSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("success"), when: predicateSchema }),
  z.object({
    kind: z.literal("business-outcome"),
    name: z.string().regex(OUTCOME_NAME),
    when: predicateSchema,
  }),
]);

export type TerminalState = z.infer<typeof terminalStateSchema>;

/**
 * The Contract's inputs and outputs are JSON Schema in the file rather than a
 * Zod declaration, so that a calling agent reads the Contract without importing
 * any code. They are generated from Zod — see `jsonSchemaFor` — so the one
 * declaration still serves both.
 *
 * Validated loosely on purpose: this checks it is a JSON Schema object with
 * named properties, and leaves the rest of the vocabulary alone rather than
 * reimplementing JSON Schema in Zod.
 */
export const jsonSchemaObject = z.looseObject({
  type: z.literal("object"),
  properties: z.record(z.string().regex(PROPERTY_NAME), z.record(z.string(), z.unknown())),
  required: z.array(z.string()).optional(),
});

export type JsonSchemaObject = z.infer<typeof jsonSchemaObject>;

/**
 * The part of a Capability a calling agent reads. The Recording is the part it
 * does not.
 */
export const contractSchema = z.object({
  /** One line, for a catalog listing and for a model choosing between Capabilities. */
  summary: z.string().min(1),
  inputs: jsonSchemaObject,
  outputs: jsonSchemaObject,
  /**
   * Declared by the Capability, never inferred by a model (ADR 0007). The
   * policy gate in #7 reads it; nothing here acts on it.
   */
  effects: z.enum(["read-only", "mutating"]),
  terminalStates: z.array(terminalStateSchema).min(1),
});

export type Contract = z.infer<typeof contractSchema>;

/** The shared Recording: the full ordered list of Steps. */
export const baseRecordingSchema = z.object({
  variant: z.literal(BASE_VARIANT),
  steps: z.array(stepSchema).min(1),
});

export type BaseRecording = z.infer<typeof baseRecordingSchema>;

/**
 * A Tenant's corrections to the base Recording, keyed by Step id.
 *
 * A patch entry replaces a Step's whole action rather than merging fields into
 * it. Whole-action replacement keeps a correction reviewable as a diff and
 * leaves no merge semantics to get subtly wrong, and the action kind is
 * required to match the base Step's so that a "correction" cannot quietly turn
 * a click into a fill.
 */
export const variantRecordingSchema = z.object({
  variant: z.string().regex(SLUG).refine((name) => name !== BASE_VARIANT, {
    message: `"${BASE_VARIANT}" is the shared Recording, not a variant`,
  }),
  patch: z.record(z.string().regex(SLUG), z.object({ action: stepActionSchema })),
});

export type VariantRecording = z.infer<typeof variantRecordingSchema>;

export const recordingSchema = z.union([baseRecordingSchema, variantRecordingSchema]);

export type Recording = z.infer<typeof recordingSchema>;

const capabilityShape = z.object({
  id: z.string().regex(SLUG),
  /**
   * One file per version, git as the version store. A new version exists only
   * when a fresh Discovery Run changes the Steps; a Tenant override is a patch
   * inside the existing one rather than a version of its own.
   */
  version: z.int().positive(),
  /** Which Surface profile this runs against — the origin, login, and route classes. */
  surface: z.string().regex(SLUG),
  /**
   * Whether a human has reviewed this Capability and signed it off.
   *
   * Draft unless the file says otherwise, so that a Capability the recorder
   * wrote unattended cannot be approved by omission. ADR 0007 makes this
   * load-bearing for a mutating Capability only: a read-only one is safe to
   * replay in either state, and a mutating one runs unattended only once
   * somebody has put their name to it.
   */
  approval: z.enum(["draft", "approved"]).default("draft"),
  contract: contractSchema,
  recordings: z.array(recordingSchema).min(1),
});

/**
 * The rules that hold between parts of a Capability rather than inside one.
 *
 * They live in the schema rather than in a reviewer's head because every one of
 * them is a way a Capability can be well-formed JSON and still un-runnable, and
 * because the recorder in #10 writes these files unattended.
 */
export const capabilitySchema = capabilityShape.superRefine((capability, ctx) => {
  checkTerminalStates(capability.contract.terminalStates, ctx);
  checkRecordings(capability.recordings, ctx);
  checkPatches(capability.recordings, ctx);
  checkContractAgreement(capability, ctx);
});

export type Capability = z.infer<typeof capabilitySchema>;

/** ADR 0004: exactly one success, and Business Outcomes a caller can tell apart. */
function checkTerminalStates(states: TerminalState[], ctx: z.RefinementCtx): void {
  const successes = states.filter((state) => state.kind === "success");
  if (successes.length !== 1) {
    ctx.addIssue({
      code: "custom",
      path: ["contract", "terminalStates"],
      message: `A Contract declares exactly one success Terminal State; found ${successes.length}.`,
    });
  }

  const seen = new Set<string>();
  for (const state of states) {
    if (state.kind !== "business-outcome") continue;
    if (seen.has(state.name)) {
      ctx.addIssue({
        code: "custom",
        path: ["contract", "terminalStates"],
        message: `Business Outcome "${state.name}" is declared more than once.`,
      });
    }
    seen.add(state.name);
  }
}

function checkRecordings(recordings: Recording[], ctx: z.RefinementCtx): void {
  const bases = recordings.filter(isBaseRecording);
  if (bases.length !== 1) {
    ctx.addIssue({
      code: "custom",
      path: ["recordings"],
      message: `A Capability has exactly one base Recording; found ${bases.length}.`,
    });
  }

  recordings.forEach((recording, index) => {
    if (!isBaseRecording(recording)) return;
    const seen = new Set<string>();
    for (const step of recording.steps) {
      if (seen.has(step.id)) {
        ctx.addIssue({
          code: "custom",
          path: ["recordings", index, "steps"],
          message: `Step id "${step.id}" is used more than once; Step ids identify a Step.`,
        });
      }
      seen.add(step.id);
    }
  });

  const variants = new Set<string>();
  for (const recording of recordings) {
    if (isBaseRecording(recording)) continue;
    if (variants.has(recording.variant)) {
      ctx.addIssue({
        code: "custom",
        path: ["recordings"],
        message: `Variant "${recording.variant}" has more than one Recording.`,
      });
    }
    variants.add(recording.variant);
  }
}

/** Which of the two Recording shapes this is — the base holds Steps, a variant a patch. */
export function isBaseRecording(recording: Recording): recording is BaseRecording {
  return recording.variant === BASE_VARIANT;
}

/**
 * A patch names Steps by id, so a key that matches nothing applies silently to
 * nothing and the Tenant runs the uncorrected flow. That has to be loud.
 *
 * The action kind must match too: a correction says "this control is different
 * here", and one that turned a click into a fill would be a different Recording
 * wearing a patch's clothes.
 */
function checkPatches(recordings: Recording[], ctx: z.RefinementCtx): void {
  const base = recordings.find(isBaseRecording);
  if (base === undefined) return;
  const steps = new Map(base.steps.map((step) => [step.id, step]));

  recordings.forEach((recording, index) => {
    if (isBaseRecording(recording)) return;
    for (const [stepId, override] of Object.entries(recording.patch)) {
      const step = steps.get(stepId);
      if (step === undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["recordings", index, "patch", stepId],
          message: `Variant "${recording.variant}" patches Step "${stepId}", which the base Recording does not have.`,
        });
        continue;
      }
      if (override.action.kind !== step.action.kind) {
        ctx.addIssue({
          code: "custom",
          path: ["recordings", index, "patch", stepId],
          message: `Step "${stepId}" is a ${step.action.kind} in the base Recording but a ${override.action.kind} in variant "${recording.variant}"; a patch corrects a Step, it does not replace it.`,
        });
      }
    }
  });
}

/**
 * The Contract and the Recording describing the same Capability.
 *
 * A Step referencing an input nobody supplies has nothing to substitute at
 * replay time, and a Contract promising an output no Step reads is a Capability
 * that succeeds and returns nothing for it. Both are caught here rather than at
 * the end of a run against a live application.
 */
function checkContractAgreement(
  capability: z.infer<typeof capabilityShape>,
  ctx: z.RefinementCtx,
): void {
  const inputs = new Set(Object.keys(capability.contract.inputs.properties));
  const outputs = new Set(Object.keys(capability.contract.outputs.properties));

  for (const state of capability.contract.terminalStates) {
    for (const reference of inputReferencesInPredicate(state.when)) {
      if (inputs.has(reference)) continue;
      ctx.addIssue({
        code: "custom",
        path: ["contract", "terminalStates"],
        message: `A Terminal State references input "${reference}", which the Contract does not declare.`,
      });
    }
  }

  const bound = new Set<string>();
  for (const [index, recording] of capability.recordings.entries()) {
    for (const [stepId, action] of actionsOf(recording)) {
      for (const reference of inputReferencesInAction(action)) {
        if (inputs.has(reference)) continue;
        ctx.addIssue({
          code: "custom",
          path: ["recordings", index],
          message: `Step "${stepId}" references input "${reference}", which the Contract does not declare.`,
        });
      }
      if (action.kind !== "read") continue;
      if (!outputs.has(action.bind)) {
        ctx.addIssue({
          code: "custom",
          path: ["recordings", index],
          message: `Step "${stepId}" binds output "${action.bind}", which the Contract does not declare.`,
        });
      }
      if (isBaseRecording(recording)) bound.add(action.bind);
    }
  }

  for (const output of outputs) {
    if (bound.has(output)) continue;
    ctx.addIssue({
      code: "custom",
      path: ["contract", "outputs"],
      message: `The Contract declares output "${output}", which no Step in the base Recording reads.`,
    });
  }
}

/** Every action a Recording carries, paired with the Step id it belongs to. */
function actionsOf(recording: Recording): [string, StepAction][] {
  return isBaseRecording(recording)
    ? recording.steps.map((step) => [step.id, step.action])
    : Object.entries(recording.patch).map(([stepId, override]) => [stepId, override.action]);
}

function inputReferencesInAction(action: StepAction): string[] {
  switch (action.kind) {
    case "navigate":
      return inputReferencesInExpression(action.url);
    case "fill":
      return [
        ...inputReferencesInLocator(action.locator),
        ...inputReferencesInExpression(action.value),
      ];
    case "select":
      return [
        ...inputReferencesInLocator(action.locator),
        ...inputReferencesInExpression(action.option),
      ];
    default:
      return inputReferencesInLocator(action.locator);
  }
}

function inputReferencesInPredicate(predicate: Predicate): string[] {
  switch (predicate.kind) {
    case "present":
    case "absent":
      return inputReferencesInLocator(predicate.locator);
    default:
      return predicate.of.flatMap(inputReferencesInPredicate);
  }
}

function inputReferencesInLocator(locator: StepLocator): string[] {
  return [
    ...(locator.name === undefined ? [] : inputReferencesInExpression(locator.name)),
    ...(locator.within === undefined ? [] : inputReferencesInLocator(locator.within)),
  ];
}

function inputReferencesInExpression(expression: Expression): string[] {
  return expression.kind === "input" ? [expression.input] : [];
}
