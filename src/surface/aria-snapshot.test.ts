import { describe, expect, it } from "vitest";
import { readAriaSnapshot, reportAddressability } from "./aria-snapshot.js";

describe("readAriaSnapshot", () => {
  it("reads a role and its accessible name from a leaf node", () => {
    const nodes = readAriaSnapshot(`- textbox "Username"`);

    expect(nodes).toEqual([{ role: "textbox", name: "Username", depth: 0 }]);
  });

  it("records nesting depth and reads a named container that has children", () => {
    // A real fragment of ParaBank's Accounts Overview table.
    const nodes = readAriaSnapshot(
      [
        `- row "12345 -$2300.00 $0.00":`,
        `  - cell "12345":`,
        `    - link "12345":`,
        `  - cell "-$2300.00"`,
      ].join("\n"),
    );

    expect(nodes).toEqual([
      { role: "row", name: "12345 -$2300.00 $0.00", depth: 0 },
      { role: "cell", name: "12345", depth: 1 },
      { role: "link", name: "12345", depth: 2 },
      { role: "cell", name: "-$2300.00", depth: 1 },
    ]);
  });

  it("reads a node whose name carries a colon, which YAML quotes as a key", () => {
    // Verbatim from ParaBank's Account Details page. The value the flagship
    // Capability reads lives in exactly this shape, so dropping it is not an
    // edge case — it is the main case.
    const nodes = readAriaSnapshot(
      [`- 'row "Balance: -$2300.00"':`, `  - cell "Balance:"`].join("\n"),
    );

    expect(nodes).toEqual([
      { role: "row", name: "Balance: -$2300.00", depth: 0 },
      { role: "cell", name: "Balance:", depth: 1 },
    ]);
  });

  it("reads a node's trailing state, keeping the chosen option apart from the rest", () => {
    // Which option is selected is the only thing distinguishing a combobox's
    // current value from the list of values it offers, so a read of a combobox
    // has nothing to go on without it.
    const nodes = readAriaSnapshot(
      [
        `- heading "Customer Login" [level=2]`,
        `- option "All"`,
        `- option "Credit" [selected]`,
      ].join("\n"),
    );

    expect(nodes).toEqual([
      { role: "heading", name: "Customer Login", depth: 0 },
      { role: "option", name: "All", depth: 0 },
      { role: "option", name: "Credit", depth: 0, selected: true },
    ]);
  });

  it("reads what has been typed into a field, which its accessible name never carries", () => {
    // ParaBank's login inputs, before and after something is typed. The value
    // arrives as inline content; the node stays unnamed either way.
    const nodes = readAriaSnapshot([`- textbox: some-user`, `- textbox`].join("\n"));

    expect(nodes).toEqual([
      { role: "textbox", name: undefined, depth: 0, text: "some-user" },
      { role: "textbox", name: undefined, depth: 0 },
    ]);
  });

  it("leaves the name undefined on an unnamed node, and skips property lines", () => {
    // ParaBank's login form, verbatim: the textboxes carry no accessible name,
    // and `/url:` is a property of the link above it rather than a node.
    const nodes = readAriaSnapshot(
      [
        `- link "Register":`,
        `  - /url: register.htm`,
        `- paragraph: Username`,
        `- textbox`,
        `- text: Experience the difference`,
      ].join("\n"),
    );

    expect(nodes).toEqual([
      { role: "link", name: "Register", depth: 0 },
      { role: "paragraph", name: undefined, depth: 0, text: "Username" },
      { role: "textbox", name: undefined, depth: 0 },
    ]);
  });
});

describe("reportAddressability", () => {
  it("separates named controls from unnamed ones and ignores non-control roles", () => {
    const nodes = readAriaSnapshot(
      [
        `- heading "Customer Login"`,
        `- paragraph: Username`,
        `- textbox`,
        `- button "Log In"`,
      ].join("\n"),
    );

    const report = reportAddressability(nodes);

    expect(report.addressable).toEqual([
      { role: "button", name: "Log In", depth: 0 },
    ]);
    expect(report.unaddressable).toEqual([
      { role: "textbox", name: undefined, depth: 0 },
    ]);
  });

  it("flags a role and name shared by more than one control as ambiguous", () => {
    const nodes = readAriaSnapshot(
      [`- link "Home"`, `- link "Home"`, `- link "Log Out"`].join("\n"),
    );

    const report = reportAddressability(nodes);

    expect(report.ambiguous).toEqual([{ role: "link", name: "Home", count: 2 }]);
  });
});
