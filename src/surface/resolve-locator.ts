/**
 * Turns a Locator into the nodes it matches in a parsed accessibility tree.
 *
 * This is what lets the fake Surface be honest rather than a stub: it resolves
 * Locators against a real captured tree by the same rules the browser uses, so
 * a Locator that is ambiguous in the fake is ambiguous in the browser too.
 */
import { descendantsOf, type AriaNode } from "./aria-snapshot.js";
import type { Locator } from "./surface.js";

export function resolveLocator(nodes: readonly AriaNode[], locator: Locator): AriaNode[] {
  return resolveLocatorIndices(nodes, locator).map((index) => nodes[index]!);
}

/**
 * The same resolution, reported as positions in the tree.
 *
 * A Surface needs this rather than the nodes: two cells in the same row can
 * carry identical text, so a control is only identified by where it sits. It is
 * also the only handle stable enough to key per-control state — what was typed
 * into a box — against.
 */
export function resolveLocatorIndices(nodes: readonly AriaNode[], locator: Locator): number[] {
  const candidates = searchableIndices(nodes, locator.within);
  const matched = candidates.filter((index) => {
    const node = nodes[index]!;
    return node.role === locator.role && matchesName(node, locator);
  });

  if (locator.ordinal === undefined) return matched;
  const nth = matched[locator.ordinal];
  return nth === undefined ? [] : [nth];
}

/**
 * Which positions a Locator may look at: everything, or only what lies inside
 * its parent. A parent matching several controls is searched in all of them —
 * the same rule Playwright applies to a chained locator — so that the ambiguity
 * surfaces at the Locator that is actually ambiguous rather than being hidden
 * one level up.
 */
function searchableIndices(nodes: readonly AriaNode[], within: Locator | undefined): number[] {
  if (within === undefined) return nodes.map((_, index) => index);

  const inside = new Set<number>();
  for (const parent of resolveLocatorIndices(nodes, within)) {
    for (const child of descendantsOf(nodes, parent)) inside.add(child);
  }
  return [...inside].sort((a, b) => a - b);
}

/**
 * Mirrors how Playwright matches an accessible name, so that a Locator means
 * the same thing to the fake and to the browser: whitespace collapsed, and by
 * default a case-insensitive substring rather than the whole name. `exact`
 * asks for the whole name, and is then case-sensitive.
 *
 * A Locator with no name matches on role alone, which is how ParaBank's
 * unnamed login inputs are reached at all.
 */
function matchesName(node: AriaNode, locator: Locator): boolean {
  if (locator.name === undefined) return true;
  if (node.name === undefined) return false;

  const actual = normalize(node.name);
  const wanted = normalize(locator.name);

  return locator.exact === true
    ? actual === wanted
    : actual.toLowerCase().includes(wanted.toLowerCase());
}

function normalize(name: string): string {
  return name.trim().replace(/\s+/g, " ");
}
