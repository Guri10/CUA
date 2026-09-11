/**
 * The node-to-handle mapping — the inverse of the resolver (ADR 0011).
 *
 * The resolver takes a Locator to the node it names; this takes a node the
 * resolver landed on and derives a Locator that names it back. It is the one
 * genuinely new piece the one-perceived-tree Surface needs: to physically click
 * or type, the live Surface must turn a resolved node into a browser handle, and
 * it must do so from the node's own role/name/ordinal path — never by re-finding
 * the control with a fresh role-based count, which would re-import the wrapper
 * divergence ADR 0011 removes.
 *
 * So the ordinal is counted the way the tree counts: by asking the very resolver
 * that will later resolve the derived path how many nodes a role (and name) match
 * and where the target sits among them. That makes the derivation self-checking —
 * the path it returns resolves back to exactly the node it was built for — and
 * keeps it pure, a function over the parsed tree with no browser and no DOM, the
 * seam #40 covers on tree fixtures.
 *
 * It stays inside ADR 0001's vocabulary: role, accessible name, ordinal. No CSS,
 * no XPath, and no `within` — a flat role/name/ordinal path is enough to single
 * out any node the tree holds, because the ordinal is global to the role.
 */
import { ARIA_ROLES, type AriaRole } from "./aria-roles.js";
import { type AriaNode } from "./aria-snapshot.js";
import { resolveLocatorIndices } from "./resolve-locator.js";
import type { Locator } from "./surface.js";

const ROLE_SET: ReadonlySet<string> = new Set(ARIA_ROLES);

export function locatorForNode(nodes: readonly AriaNode[], target: number): Locator {
  const node = nodes[target];
  if (node === undefined) {
    throw new Error(`locatorForNode: no node at index ${target}.`);
  }
  const role = asRole(node.role);

  // A name first, when the node has one: it is the readable, getByRole-friendly
  // handle, and an exact match does not pick up the wrapper row whose content
  // name is a superset. The target always matches its own exact name and role,
  // so it is among `byName`: a single match is the whole path, several are
  // disambiguated by where the target sits among them — counted the tree way,
  // since `byName` is the resolver's own answer.
  if (node.name !== undefined && node.name.trim() !== "") {
    const named: Locator = { role, name: node.name, exact: true };
    const byName = resolveLocatorIndices(nodes, named);
    if (byName.length === 1) return named;
    return { ...named, ordinal: byName.indexOf(target) };
  }

  // Unnamed: the node's position among every control of its role — the ADR 0001
  // case. A role-only query finds every node of that role, so it finds this one.
  const byRole = resolveLocatorIndices(nodes, { role });
  return { role, ordinal: byRole.indexOf(target) };
}

/** A node's role as a Locator role, or a loud failure if it is off-vocabulary. */
function asRole(role: string): AriaRole {
  if (!ROLE_SET.has(role)) {
    throw new Error(`locatorForNode: role "${role}" is not in the ARIA vocabulary (ADR 0001).`);
  }
  return role as AriaRole;
}
