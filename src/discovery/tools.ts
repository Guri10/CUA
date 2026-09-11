/**
 * The tools the model acts through during a Discovery Run.
 *
 * Seven verbs, per ADR 0002: `click`, `fill`, `select`, `read`, `read_each`,
 * `wait_for`, and `done`. The first six are the Step vocabulary of a Recording
 * exactly, so that turning a Discovery Run into a Recording is a filter over the
 * successful calls rather than a translation of a transcript into some other
 * shape — which is what #10 does with them. `tools.test.ts` holds that
 * correspondence to the `Action` union mechanically rather than by eye.
 *
 * Declared in Zod and generated with the same `jsonSchemaFor` the Contract uses,
 * so the one declaration serves the static types, the runtime validation of what
 * comes back from the model, and the schema the model is given. Three copies of
 * this shape drifting apart is a run that fails on the third turn.
 *
 * **There is no `navigate`.** The Step vocabulary has one and this deliberately
 * does not: the run is put at its entry point before the loop starts, and from
 * there the model moves the way an operator does, by clicking what is on the
 * screen. A verb taking a URL would let the model name any address it liked and
 * leave the allowlist as the only thing between it and another application. The
 * gate would refuse it — but a guardrail that is load-bearing is a guardrail
 * being leaned on, and not offering the verb is cheaper than refusing it.
 */
import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { jsonSchemaFor } from "../capability/json-schema.js";
import { ARIA_ROLES } from "../surface/aria-roles.js";

/**
 * On every tool, and the whole of user story 17 — "see why the model chose each
 * action, so that I can judge whether the Recording is sound before approving
 * it". It is printed for the operator and never written to evidence: ADR 0006
 * persists a filtered transcript precisely because a sentence of prose can
 * mention a balance and no field-level masking can catch it.
 */
const reason = z
  .string()
  .min(1)
  .describe("One sentence on why this action, and what you expect it to do.");

/**
 * Bounds as refinements rather than as `min` and `max`.
 *
 * A strict tool schema refuses `minimum` and `maximum` on an integer, and the
 * whole point of generating the tool schema from the Zod declaration is that the
 * same declaration validates what comes back. A refinement is invisible to the
 * generated JSON Schema and still runs on the way in, so the bound survives
 * where it is load-bearing and does not appear where it is refused.
 */
const nonNegative = z.int().refine((value) => value >= 0, "must be zero or more");
const atLeastOne = z.int().refine((value) => value >= 1, "must be at least 1");

/** The leaf of a scope chain: a control named only by role and accessible name. */
const scope = z.object({
  role: z.enum(ARIA_ROLES),
  name: z.string().optional().describe("The accessible name, matched as a case-insensitive substring."),
  exact: z.boolean().optional().describe("Match the whole accessible name rather than a substring."),
  ordinal: nonNegative.optional().describe("Zero-based. Which of several matches to take."),
});

/**
 * How the model addresses a control: ADR 0001's role and accessible name, with
 * an ordinal for the unnamed inputs ParaBank's login form serves and a `within`
 * for its label/value rows.
 *
 * `within` goes one level deep here where a Recording's Locator nests to any
 * depth. That is a limit of what the model can say, not of what can be stored: a
 * flat schema has no `$ref` in it, and every screen the accessibility survey
 * captured is reachable with one enclosing control. If a screen ever needs two,
 * this is where it grows a level.
 */
const locator = scope.extend({
  within: scope.optional().describe("Search only inside this control."),
});

export const clickInput = z.object({ reason, locator });
export const fillInput = z.object({
  reason,
  locator,
  value: z.string().describe("The text to type."),
});
export const selectInput = z.object({
  reason,
  locator,
  option: z.string().describe("The option to choose, by its visible label."),
});
export const readInput = z.object({
  reason,
  locator,
  /**
   * Which of the run's declared return values this read is for.
   *
   * A Recording's read Step carries the same field, and the recorder needs it
   * from the model rather than working it out: matching reads to return values
   * by the order they happened would silently hand back a balance under the
   * name of an account type the first time a run read something twice. Optional
   * because a run may be pure exploration with nothing declared to return, and
   * a read binding nothing is not recorded at all.
   */
  bind: z
    .string()
    .optional()
    .describe("The name of the return value this read is for, exactly as it was given."),
});
/**
 * Read a whole table at once, one record per row. This is the verb for a return
 * value that is a list — a member's shares, the lines of a statement. `read`
 * takes one control's value and calls several matches an error; this expects
 * many rows and keeps each row's columns together, so a value is only ever read
 * beside the others on its own row.
 */
export const readEachInput = z.object({
  reason,
  rows: locator.describe(
    "The rows to read — one record per matching row. Matching several is the point, not an error.",
  ),
  columns: z
    .record(z.string(), locator)
    .describe(
      "The columns to read from each row, keyed by the field name each becomes. Every Locator is " +
        "resolved inside the row, so `{ role: cell, ordinal: 2 }` is that row's third cell.",
    ),
  bind: z
    .string()
    .optional()
    .describe("The name of the list return value these rows are for, exactly as it was given."),
});
export const waitForInput = z.object({
  reason,
  locator,
  timeoutMs: atLeastOne.optional().describe("Defaults to the Surface's own."),
});
export const doneInput = z.object({
  reason,
  summary: z.string().min(1).describe("What was accomplished, and the values read."),
});

/**
 * Every tool, paired with the Zod declaration that validates what comes back.
 *
 * One table rather than a list of definitions and a separate switch, because
 * the two drifting apart is a tool the model can call and nothing can parse.
 */
export const DISCOVERY_TOOLS = {
  click: { input: clickInput, description: "Click a control." },
  fill: { input: fillInput, description: "Type text into a control." },
  select: { input: selectInput, description: "Choose an option from a control that offers several." },
  read: { input: readInput, description: "Read the current value or label of a control." },
  read_each: {
    input: readEachInput,
    description: "Read a table's rows into a list, one record per row — for a return value that is a list.",
  },
  wait_for: { input: waitForInput, description: "Wait until a control is on the screen." },
  done: {
    input: doneInput,
    description: "The goal has been met. Call this instead of an action, and the run ends.",
  },
} as const;

export type ToolName = keyof typeof DISCOVERY_TOOLS;

export function isToolName(name: string): name is ToolName {
  return Object.hasOwn(DISCOVERY_TOOLS, name);
}

/**
 * The tool definitions as the Messages API takes them.
 *
 * Not `strict`, deliberately. Strict schemas are compiled into a grammar and
 * that compilation caps a request at 24 optional parameters; a Locator carries
 * seven of them and five tools take one, which is 36. The choice was between an
 * expressive Locator and a guarantee at the API, and the Locator wins — a
 * Locator that cannot say "the second cell of the row labelled Balance:" cannot
 * describe ParaBank's account screen, and that is the screen this exists to
 * drive.
 *
 * Nothing is given up by it. `decisionFor` parses every call against the same
 * Zod declaration these are generated from, and hands a malformed one back to
 * the model as a sentence it can correct on the next turn. That is a better
 * outcome than a 400 the model never sees: the API would fail the request, and
 * this fails the call and lets the run continue.
 */
export function discoveryToolDefinitions(): Anthropic.Beta.BetaTool[] {
  return Object.entries(DISCOVERY_TOOLS).map(([name, tool]) => {
    const schema = jsonSchemaFor(tool.input);
    return {
      name,
      description: tool.description,
      input_schema: {
        ...withoutIntegerBounds(schema),
        // Spelled out rather than spread through: `strict` requires both of
        // these, and the generated schema types `required` as optional.
        required: schema.required ?? [],
        // Kept even without `strict`. It does not bind the API, but it tells the
        // model there is no other field worth inventing.
        additionalProperties: false,
      },
    };
  });
}

/**
 * The generated schema with `minimum` and `maximum` removed from every integer.
 *
 * `z.int()` writes JavaScript's safe-integer range into the schema, and the API
 * answers 400 for those two keywords on an integer — before the model sees
 * anything. Removing them loses nothing: the bounds Zod put there describe the
 * language rather than this system, and the bounds this system actually means
 * are the refinements above, which still run when the call comes back.
 *
 * Narrow on purpose. It removes those two keys and only where the type is
 * `integer`, so a bound that ever does mean something stays where it was put.
 */
function withoutIntegerBounds<T>(schema: T): T {
  if (Array.isArray(schema)) return schema.map(withoutIntegerBounds) as T;
  if (schema === null || typeof schema !== "object") return schema;

  const entries = Object.entries(schema as Record<string, unknown>)
    .filter(([key]) => {
      const isBound = key === "minimum" || key === "maximum";
      return !(isBound && (schema as { type?: unknown }).type === "integer");
    })
    .map(([key, value]) => [key, withoutIntegerBounds(value)]);

  return Object.fromEntries(entries) as T;
}
