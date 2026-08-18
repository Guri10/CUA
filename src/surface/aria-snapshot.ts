/**
 * Reads the YAML accessibility snapshot Playwright produces into a flat list of
 * nodes, each carrying the two things ADR 0001 makes the targeting contract:
 * an accessibility role and an accessible name.
 */
export interface AriaNode {
  readonly role: string;
  readonly name: string | undefined;
  readonly depth: number;
  /**
   * The content the snapshot carries inline after the colon. For a form field
   * this is its current value — `- textbox: some-user` — which is what a read
   * of that control wants, and which its accessible name does not carry.
   */
  readonly text?: string;
  /** Whether the node is marked `[selected]`, as a chosen option is. */
  readonly selected?: boolean;
}

/**
 * `  - cell "12345":` → indent, role, optional quoted accessible name, any
 * state in brackets, and any inline content after the colon.
 *
 * Content and state are kept separate from the accessible name rather than
 * folded into it, because they answer a different question. A name is how a
 * Locator finds a control; the content of `- textbox: some-user` and the
 * `[selected]` on an option are how a read gets its current value. Both
 * Surfaces answer a read from these fields, which is what stops the browser and
 * the fake disagreeing about what a control currently holds.
 */
const NODE_LINE =
  /^(?<indent> *)- (?<role>[a-zA-Z]+)(?: "(?<name>[^"]*)")?(?<states>(?: \[[^\]]*\])*)(?::(?<text>.*))?$/;

/**
 * When an accessible name contains a colon — `row "Balance: -$2300.00"`, the
 * shape the account read depends on — YAML quotes the whole key. Unwrapping
 * that before matching keeps one node pattern instead of two.
 */
const QUOTED_KEY = /^(?<indent> *)- '(?<key>.*)':$/;

/**
 * `- text: ...` is a bare run of text with no element behind it, so it can
 * never be a Locator target. It reads like a role and is not one.
 */
const NOT_A_ROLE = new Set(["text"]);

export function readAriaSnapshot(snapshot: string): AriaNode[] {
  const nodes: AriaNode[] = [];

  for (const rawLine of snapshot.split("\n")) {
    const line = unwrapQuotedKey(rawLine);
    const groups = NODE_LINE.exec(line)?.groups;
    if (groups === undefined) continue;
    if (NOT_A_ROLE.has(groups["role"]!)) continue;

    const text = groups["text"]?.trim();
    nodes.push({
      role: groups["role"]!,
      name: groups["name"],
      depth: groups["indent"]!.length / 2,
      ...(text === undefined || text === "" ? {} : { text }),
      ...(groups["states"]?.includes("[selected]") === true ? { selected: true } : {}),
    });
  }

  return nodes;
}

function unwrapQuotedKey(line: string): string {
  const groups = QUOTED_KEY.exec(line)?.groups;
  if (groups === undefined) return line;
  return `${groups["indent"]!}- ${groups["key"]!.replaceAll("''", "'")}`;
}

/**
 * The run of nodes nested under one node.
 *
 * The tree arrives flat, carrying indentation depth, so a node's descendants
 * are the run that follows it while the depth stays greater than its own. Both
 * scoping a Locator and reading a chosen option are questions about that run,
 * so the walk lives here with the shape it depends on.
 */
export function descendantsOf(nodes: readonly AriaNode[], parent: number): number[] {
  const depth = nodes[parent]?.depth;
  if (depth === undefined) return [];

  const descendants: number[] = [];
  for (let index = parent + 1; index < nodes.length && nodes[index]!.depth > depth; index += 1) {
    descendants.push(index);
  }
  return descendants;
}

/**
 * The roles a Step actually acts on. Structural roles (paragraph, list, table)
 * and read-only content roles are excluded: they are not controls, so an
 * absent accessible name on one of them says nothing about ADR 0001 holding.
 */
const CONTROL_ROLES = new Set([
  "button",
  "checkbox",
  "combobox",
  "link",
  "listbox",
  "menuitem",
  "option",
  "radio",
  "searchbox",
  "slider",
  "spinbutton",
  "switch",
  "tab",
  "textbox",
]);

export interface AmbiguousControl {
  readonly role: string;
  readonly name: string;
  readonly count: number;
}

export interface AddressabilityReport {
  /** Controls a Locator can name — role plus a non-empty accessible name. */
  readonly addressable: AriaNode[];
  /** Controls with no accessible name, reachable only by role and ordinal. */
  readonly unaddressable: AriaNode[];
  /** Role and name pairs matching several controls, so an ordinal is needed. */
  readonly ambiguous: AmbiguousControl[];
}

export function reportAddressability(nodes: AriaNode[]): AddressabilityReport {
  const controls = nodes.filter((node) => CONTROL_ROLES.has(node.role));
  const addressable = controls.filter((node) => hasName(node));

  const counts = new Map<string, AmbiguousControl>();
  for (const node of addressable) {
    const key = `${node.role} ${node.name!}`;
    const seen = counts.get(key);
    counts.set(key, {
      role: node.role,
      name: node.name!,
      count: (seen?.count ?? 0) + 1,
    });
  }

  return {
    addressable,
    unaddressable: controls.filter((node) => !hasName(node)),
    ambiguous: [...counts.values()].filter((entry) => entry.count > 1),
  };
}

function hasName(node: AriaNode): boolean {
  return node.name !== undefined && node.name.trim() !== "";
}
