/**
 * Reads the YAML accessibility snapshot Playwright produces into a flat list of
 * nodes, each carrying the two things ADR 0001 makes the targeting contract:
 * an accessibility role and an accessible name.
 */
export interface AriaNode {
  readonly role: string;
  readonly name: string | undefined;
  readonly depth: number;
}

/**
 * `  - cell "12345":` → indent, role, optional quoted accessible name. A node
 * may also carry inline text after the colon (`- paragraph: Username`); that is
 * the element's content, not its accessible name, so it is not read as one. A
 * trailing `[level=2]` or `[selected]` is state, and is not read either.
 */
const NODE_LINE =
  /^(?<indent> *)- (?<role>[a-zA-Z]+)(?: "(?<name>[^"]*)")?(?: \[[^\]]*\])*(?::.*)?$/;

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

    nodes.push({
      role: groups["role"]!,
      name: groups["name"],
      depth: groups["indent"]!.length / 2,
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
