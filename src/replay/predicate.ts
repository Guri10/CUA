/**
 * Recognising a Terminal State on the screen.
 *
 * ADR 0004 makes a Terminal State a predicate over the accessibility tree
 * rather than a boolean the executor infers from its last Step completing, so
 * this is where "did we get where we said we would" is actually answered.
 *
 * Pure, and in the ADR 0001 vocabulary only: it resolves Locators against a
 * snapshot's nodes by the same rules every other Locator in the system is
 * resolved by, which is why the fake and the browser agree on what a Terminal
 * State means.
 */
import type { Predicate } from "../capability/schema.js";
import type { AriaNode } from "../surface/aria-snapshot.js";
import { resolveLocatorIndices } from "../surface/resolve-locator.js";
import { substituteLocator, type ReplayInputs } from "./substitute.js";

export function matchesPredicate(
  nodes: readonly AriaNode[],
  predicate: Predicate,
  inputs: ReplayInputs,
): boolean {
  switch (predicate.kind) {
    case "present":
      return matchCount(nodes, predicate, inputs) > 0;

    case "absent":
      return matchCount(nodes, predicate, inputs) === 0;

    case "all":
      return predicate.of.every((branch) => matchesPredicate(nodes, branch, inputs));

    case "any":
      return predicate.of.some((branch) => matchesPredicate(nodes, branch, inputs));
  }
}

/**
 * How many controls the predicate's Locator addresses.
 *
 * Presence is "at least one", not "exactly one". An ambiguous Locator is a
 * problem when something is about to be acted on or read — and `perform`
 * reports it as one — but a Terminal State only asks whether the screen shows
 * a thing, and a screen showing it twice still shows it.
 */
function matchCount(
  nodes: readonly AriaNode[],
  predicate: Extract<Predicate, { kind: "present" | "absent" }>,
  inputs: ReplayInputs,
): number {
  return resolveLocatorIndices(nodes, substituteLocator(predicate.locator, inputs)).length;
}
