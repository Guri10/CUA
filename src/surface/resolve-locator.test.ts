import { describe, expect, it } from "vitest";
import { readAriaSnapshot } from "./aria-snapshot.js";
import { resolveLocator } from "./resolve-locator.js";

describe("resolveLocator", () => {
  it("matches every node of the role when the Locator names none", () => {
    // ParaBank's login form verbatim: two textboxes, neither with an
    // accessible name. This is the case ordinal exists for.
    const nodes = readAriaSnapshot(
      [`- paragraph: Username`, `- textbox`, `- paragraph: Password`, `- textbox`].join("\n"),
    );

    expect(resolveLocator(nodes, { role: "textbox" })).toHaveLength(2);
  });

  it("matches an accessible name as a case-insensitive substring by default", () => {
    // Verbatim from ParaBank's Account Details page. Naming the label alone has
    // to reach the row that carries the value, because the value is not known
    // in advance — that is the whole point of reading it.
    const nodes = readAriaSnapshot(
      [`- 'row "Balance: -$2300.00"':`, `- 'row "Available: $0.00"':`].join("\n"),
    );

    expect(resolveLocator(nodes, { role: "row", name: "balance:" })).toEqual([
      { role: "row", name: "Balance: -$2300.00", depth: 0 },
    ]);
  });

  it("matches the whole accessible name when the Locator asks for exact", () => {
    // Account numbers on the Accounts Overview are links named for the number
    // itself, and one number can be a prefix of another. A substring match
    // would open the wrong account and everything after it would look fine.
    const nodes = readAriaSnapshot([`- link "12345"`, `- link "123456"`].join("\n"));

    expect(resolveLocator(nodes, { role: "link", name: "12345" })).toHaveLength(2);
    expect(resolveLocator(nodes, { role: "link", name: "12345", exact: true })).toEqual([
      { role: "link", name: "12345", depth: 0 },
    ]);
  });

  it("never matches an unnamed node against a Locator that names one", () => {
    const nodes = readAriaSnapshot([`- textbox`, `- textbox "Search"`].join("\n"));

    expect(resolveLocator(nodes, { role: "textbox", name: "Search" })).toHaveLength(1);
  });

  it("searches only inside the parent when the Locator is scoped", () => {
    // Verbatim from the Account Details page. Both value cells are named for
    // their value, so the only thing telling "the balance" from "the available
    // amount" is which row it sits in.
    const nodes = readAriaSnapshot(
      [
        `- 'row "Balance: -$2300.00"':`,
        `  - cell "Balance:"`,
        `  - cell "-$2300.00"`,
        `- 'row "Available: $0.00"':`,
        `  - cell "Available:"`,
        `  - cell "$0.00"`,
      ].join("\n"),
    );

    const matches = resolveLocator(nodes, {
      role: "cell",
      ordinal: 1,
      within: { role: "row", name: "Balance:" },
    });

    expect(matches).toEqual([{ role: "cell", name: "-$2300.00", depth: 1 }]);
  });

  it("scopes through more than one level of parent", () => {
    // The two filters on the Account Details page are unnamed comboboxes, and
    // the cell around each is named "All" for its selected value rather than
    // for the field. Only the enclosing row tells them apart, so this needs a
    // two-level scope — the case the accessibility survey called out.
    const nodes = readAriaSnapshot(
      [
        `- 'row "Activity Period: All"':`,
        `  - cell "Activity Period:"`,
        `  - cell "All":`,
        `    - combobox:`,
        `      - option "All" [selected]`,
        `      - option "January"`,
        `- 'row "Type: All"':`,
        `  - cell "Type:"`,
        `  - cell "All":`,
        `    - combobox:`,
        `      - option "All" [selected]`,
        `      - option "Credit"`,
      ].join("\n"),
    );

    const typeFilter = resolveLocator(nodes, {
      role: "combobox",
      within: { role: "cell", name: "All", within: { role: "row", name: "Type:" } },
    });

    expect(typeFilter).toEqual([{ role: "combobox", name: undefined, depth: 2 }]);
    // And the scope really is doing the work: unscoped, both filters match.
    expect(resolveLocator(nodes, { role: "combobox" })).toHaveLength(2);
  });

  it("takes the nth match when the Locator carries an ordinal", () => {
    // ParaBank's password field. Nothing but its position distinguishes it.
    const nodes = readAriaSnapshot(
      [`- textbox`, `- textbox`, `- button "Log In"`].join("\n"),
    );

    expect(resolveLocator(nodes, { role: "textbox", ordinal: 1 })).toEqual([
      { role: "textbox", name: undefined, depth: 0 },
    ]);
    expect(resolveLocator(nodes, { role: "textbox", ordinal: 2 })).toEqual([]);
  });

  it("yields nothing when the parent itself is not on the screen", () => {
    const nodes = readAriaSnapshot([`- cell "-$2300.00"`].join("\n"));

    expect(
      resolveLocator(nodes, { role: "cell", within: { role: "row", name: "Balance:" } }),
    ).toEqual([]);
  });
});
