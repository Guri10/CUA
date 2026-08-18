/**
 * Saying what a Step was aiming at, in words.
 *
 * A Hard Failure has to carry what was expected, and the only honest answer is
 * the Locator itself — but a Locator printed as JSON in a terminal is a wall.
 * These render the same thing as a phrase, in the ADR 0001 vocabulary and no
 * other: role, accessible name, scope, ordinal. Nothing here is parsed back.
 */
import type { Predicate } from "../capability/schema.js";
import type { Action, ActionResult, Locator } from "../surface/surface.js";
import { substituteLocator, type ReplayInputs } from "./substitute.js";

export function describeLocator(locator: Locator): string {
  const parts: string[] = [locator.role];
  if (locator.name !== undefined) parts.push(JSON.stringify(locator.name));
  if (locator.exact === true) parts.push("(exact)");
  if (locator.ordinal !== undefined) parts.push(`#${locator.ordinal}`);
  if (locator.within !== undefined) parts.push(`within ${describeLocator(locator.within)}`);
  return parts.join(" ");
}

export function describeAction(action: Action): string {
  switch (action.kind) {
    case "navigate":
      return `navigate to ${action.url}`;
    case "click":
      return `click on ${describeLocator(action.locator)}`;
    case "fill":
      // Deliberately not the value. ADR 0006 classes what gets typed into a box
      // as at least Sensitive, and a failure report is written out.
      return `fill of ${describeLocator(action.locator)}`;
    case "select":
      return `select of ${describeLocator(action.locator)}`;
    case "read":
      return `read of ${describeLocator(action.locator)}`;
    case "waitFor":
      return `wait for ${describeLocator(action.locator)}`;
  }
}

/**
 * A Terminal State's predicate as a phrase. `all` and `any` read as the words
 * they are, so a failure report says what the Capability was actually waiting
 * to see rather than that "the Terminal State did not match".
 */
export function describePredicate(predicate: Predicate, inputs: ReplayInputs): string {
  switch (predicate.kind) {
    case "present":
    case "absent":
      // Substituted, so that the report names the account the run was actually
      // looking for rather than the blank the Recording stores.
      return `${describeLocator(substituteLocator(predicate.locator, inputs))} ${predicate.kind}`;
    default:
      return `${predicate.kind} of [${predicate.of
        .map((branch) => describePredicate(branch, inputs))
        .join(", ")}]`;
  }
}

/**
 * Why an Action did not happen, as one phrase.
 *
 * All three are returned values rather than thrown errors, and all three end a
 * Replay: a Recording that cannot find its control has nothing left to try, one
 * that finds several has no way to know which the recorder meant, and one the
 * policy gate refused is not going to be allowed on a second attempt either.
 */
export function describeMiss(result: Exclude<ActionResult, { kind: "ok" }>): string {
  switch (result.kind) {
    case "not-found":
      return "no control matched";
    case "ambiguous":
      return `${result.matches} controls matched`;
    case "refused":
      return result.reason;
  }
}
