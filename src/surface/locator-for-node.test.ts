import { describe, expect, it } from "vitest";
import { readAriaSnapshot, type AriaNode } from "./aria-snapshot.js";
import { capturedMeridianTree } from "./meridian/fake-script.js";
import { locatorForNode } from "./locator-for-node.js";
import { readControlValue } from "./read-value.js";
import { resolveLocatorIndices } from "./resolve-locator.js";

/**
 * The node-to-handle mapping (ADR 0011): the inverse of the resolver. Given a
 * node the shared resolver landed on, it derives a role/name/ordinal Locator
 * that targets exactly that node — the path the live Surface will act on rather
 * than re-finding the control by a fresh role-based count. Everything here is a
 * pure function over a parsed tree, so it is covered on tree fixtures with no
 * browser (this is the preferred seam of #40).
 *
 * The invariant every case rests on: a derived path, resolved through the very
 * resolver it was counted against, comes back to the one node it was built for.
 */
function roundTrips(nodes: readonly AriaNode[], target: number): void {
  expect(resolveLocatorIndices(nodes, locatorForNode(nodes, target))).toEqual([target]);
}

describe("locatorForNode", () => {
  it("derives a bare name path for a uniquely-named control", () => {
    const nodes = readAriaSnapshot(["- form:", '  - button "Save"', "  - textbox", "  - textbox"].join("\n"));

    // button "Save" is the only button, so its name alone targets it — no ordinal.
    expect(locatorForNode(nodes, 1)).toEqual({ role: "button", name: "Save", exact: true });
  });

  it("derives a role-and-ordinal path for an unnamed control, counted the tree way", () => {
    const nodes = readAriaSnapshot(["- form:", '  - button "Save"', "  - textbox", "  - textbox"].join("\n"));

    // Two unnamed textboxes, told apart only by position — the ADR 0001 case.
    expect(locatorForNode(nodes, 2)).toEqual({ role: "textbox", ordinal: 0 });
    expect(locatorForNode(nodes, 3)).toEqual({ role: "textbox", ordinal: 1 });
  });

  it("adds a tree-counted ordinal when a name is shared by several controls", () => {
    const nodes = readAriaSnapshot(["- list:", '  - button "Go"', '  - button "Go"'].join("\n"));

    expect(locatorForNode(nodes, 1)).toEqual({ role: "button", name: "Go", exact: true, ordinal: 0 });
    expect(locatorForNode(nodes, 2)).toEqual({ role: "button", name: "Go", exact: true, ordinal: 1 });
  });

  it("targets the value cell of the member-record identity row, not the label", () => {
    const record = readAriaSnapshot(capturedMeridianTree("member-100234"));

    // The value cell as member-lookup reads it: cell ordinal 1 within the row
    // whose first label is "Member No.:" — the number, not the "Member No.:" label.
    const [valueCell] = resolveLocatorIndices(record, {
      role: "cell",
      ordinal: 1,
      within: { role: "row", name: "Member No.:" },
    });
    expect(valueCell).toBeDefined();

    const path = locatorForNode(record, valueCell!);
    const resolved = resolveLocatorIndices(record, path);

    expect(resolved).toEqual([valueCell]);
    expect(readControlValue(record, resolved[0]!)).toBe("100234");
    // The regression this whole line of work exists for: never the field label.
    expect(readControlValue(record, resolved[0]!)).not.toBe("Member No.:");
  });

  it("round-trips every addressable node in the captured member record", () => {
    const record = readAriaSnapshot(capturedMeridianTree("member-100234"));

    // Every node the tree carries is reachable from the path derived for it —
    // the property the wiring in #43 will lean on.
    record.forEach((_node, index) => roundTrips(record, index));
  });

  it("refuses a node index that is not in the tree", () => {
    const nodes = readAriaSnapshot(["- form:", "  - textbox"].join("\n"));
    expect(() => locatorForNode(nodes, 99)).toThrow();
  });
});
