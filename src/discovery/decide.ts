/**
 * What the model said, turned into something the Surface can take — and what
 * came back, turned into something the model can read.
 *
 * Both directions are pure functions over values, which is the whole of what
 * this system tests about the discovery path. The spec draws the line there on
 * purpose: the model's decisions are non-deterministic and asserting on them
 * tests Anthropic rather than this system, but given a tool call the Action it
 * becomes is fixed, and so is the sentence sent back.
 *
 * Nothing here throws on bad input from the model. A malformed argument arrives
 * as a complaint the model is handed and gets to correct on the next turn,
 * because ending a run over an argument the model could have fixed is worse
 * than one wasted turn — and the same reasoning ADR 0004 and ADR 0005 apply to
 * expected-but-negative states applies to this one.
 */
import { z } from "zod";
import type { Action, ActionResult, Locator } from "../surface/surface.js";
import { describeMiss } from "../replay/describe.js";
import { DISCOVERY_TOOLS, isToolName } from "./tools.js";

export type Decision =
  | { readonly kind: "act"; readonly reason: string; readonly action: Action }
  | { readonly kind: "done"; readonly reason: string; readonly summary: string }
  /** The model asked for something that does not parse. It is told, and retries. */
  | { readonly kind: "unusable"; readonly complaint: string };

export function decisionFor(name: string, input: unknown): Decision {
  if (!isToolName(name)) {
    return { kind: "unusable", complaint: `There is no "${name}" tool. Use one of the tools given.` };
  }

  const parsed = DISCOVERY_TOOLS[name].input.safeParse(input);
  if (!parsed.success) return { kind: "unusable", complaint: complaintFrom(parsed.error) };

  const call = parsed.data;
  if (name === "done") {
    const { reason, summary } = call as z.infer<typeof DISCOVERY_TOOLS.done.input>;
    return { kind: "done", reason, summary };
  }

  return { kind: "act", reason: call.reason, action: actionFor(name, call) };
}

/**
 * The one place the tool vocabulary and the `Action` union are stitched
 * together. It is a rename and nothing more — which is ADR 0002's claim, and
 * `tools.test.ts` is what keeps it a rename rather than a translation.
 *
 * Every branch names the fields it takes rather than spreading the parsed call.
 * Spreading is shorter and wrong: `reason` is on every tool input and belongs to
 * the operator's transcript, not to the Action, and an Action carrying it would
 * put a sentence of the model's prose into the evidence log — the one thing ADR
 * 0006 keeps out of it.
 */
function actionFor(name: Exclude<keyof typeof DISCOVERY_TOOLS, "done">, call: object): Action {
  switch (name) {
    case "click": {
      const { locator } = call as z.infer<typeof DISCOVERY_TOOLS.click.input>;
      return { kind: "click", locator: locatorFrom(locator) };
    }
    case "fill": {
      const { locator, value } = call as z.infer<typeof DISCOVERY_TOOLS.fill.input>;
      return { kind: "fill", locator: locatorFrom(locator), value };
    }
    case "select": {
      const { locator, option } = call as z.infer<typeof DISCOVERY_TOOLS.select.input>;
      return { kind: "select", locator: locatorFrom(locator), option };
    }
    case "read": {
      const { locator } = call as z.infer<typeof DISCOVERY_TOOLS.read.input>;
      return { kind: "read", locator: locatorFrom(locator) };
    }
    case "wait_for": {
      const { locator, timeoutMs } = call as z.infer<typeof DISCOVERY_TOOLS.wait_for.input>;
      return {
        kind: "waitFor",
        locator: locatorFrom(locator),
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
      };
    }
  }
}

/**
 * The parsed Locator with its absent fields actually absent.
 *
 * Zod hands back `{ name: undefined }` for an optional the model omitted, and a
 * present key holding `undefined` is a different thing from a missing one — to
 * the type checker under `exactOptionalPropertyTypes`, and to anything that
 * counts the keys of a Locator to decide how specific it is.
 */
function locatorFrom(locator: z.infer<typeof DISCOVERY_TOOLS.click.input>["locator"]): Locator {
  return {
    role: locator.role,
    ...(locator.name === undefined ? {} : { name: locator.name }),
    ...(locator.exact === undefined ? {} : { exact: locator.exact }),
    ...(locator.ordinal === undefined ? {} : { ordinal: locator.ordinal }),
    ...(locator.within === undefined ? {} : { within: locatorFrom(locator.within) }),
  };
}

/** What the model is told an Action produced. */
export interface Report {
  readonly text: string;
  /**
   * Marked as an error on the tool result, so that a miss reads as a miss
   * rather than as a value the model might take at face value. A miss is not a
   * crash — it is the loop's ordinary way of saying "try something else".
   */
  readonly isError: boolean;
}

export function reportOf(result: ActionResult): Report {
  if (result.kind === "ok") {
    // A read's value goes back in full. It is Sensitive, and ADR 0006 masks a
    // Sensitive value in what is stored, never in what is handed to the caller
    // — and here the model is the caller. What it is not is written to
    // evidence; the decorator underneath has already masked it there.
    return {
      text: result.value === undefined ? "ok" : `ok: ${JSON.stringify(result.value)}`,
      isError: false,
    };
  }

  return { text: describeMiss(result), isError: true };
}

/** Zod's issues as one sentence the model can act on, paths included. */
function complaintFrom(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
}
