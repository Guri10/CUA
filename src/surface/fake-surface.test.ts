import { describe, expect, it } from "vitest";
import { FakeSurface, type Script } from "./fake-surface.js";
import type { Locator } from "./surface.js";

/**
 * A deliberately tiny script. This file is about the fake's own machinery; the
 * fake driving the real captured ParaBank trees is `parabank/login.test.ts`.
 */
const SCRIPT: Script = {
  screens: [
    {
      name: "login",
      url: "https://example.test/index.htm",
      tree: [`- heading "Customer Login"`, `- textbox`, `- textbox`, `- button "Log In"`].join(
        "\n",
      ),
      transitions: [
        { when: { kind: "click", locator: { role: "button", name: "Log In" } }, to: "overview" },
      ],
    },
    {
      name: "overview",
      url: "https://example.test/overview.htm",
      tree: [
        `- heading "Accounts Overview"`,
        `- link "Home"`,
        `- link "Home"`,
        `- 'row "Balance: -$2300.00"':`,
        `  - cell "Balance:"`,
        `  - cell "-$2300.00"`,
        `- 'row "Type: All"':`,
        `  - cell "Type:"`,
        `  - cell "All":`,
        `    - combobox:`,
        `      - option "All" [selected]`,
        `      - option "Credit"`,
      ].join("\n"),
    },
  ],
};

describe("FakeSurface", () => {
  it("starts on a blank screen, so an interaction has to navigate like the real one does", async () => {
    const surface = new FakeSurface(SCRIPT);

    const snapshot = await surface.snapshot();

    expect(snapshot.url).toBe("about:blank");
    expect(snapshot.nodes).toEqual([]);
  });

  it("navigates to a scripted screen and reports its tree", async () => {
    const surface = new FakeSurface(SCRIPT);

    const result = await surface.perform({
      kind: "navigate",
      url: "https://example.test/index.htm",
    });
    const snapshot = await surface.snapshot();

    expect(result).toEqual({ kind: "ok" });
    expect(snapshot.url).toBe("https://example.test/index.htm");
    expect(snapshot.tree).toContain(`- button "Log In"`);
    expect(snapshot.nodes).toContainEqual({ role: "button", name: "Log In", depth: 0 });
  });

  it("refuses to guess at a screen the script does not describe", async () => {
    const surface = new FakeSurface(SCRIPT);

    await expect(
      surface.perform({ kind: "navigate", url: "https://example.test/transfer.htm" }),
    ).rejects.toThrow(/transfer\.htm/);
  });

  it("moves to the next screen when the scripted control is clicked", async () => {
    const surface = new FakeSurface(SCRIPT);
    await surface.perform({ kind: "navigate", url: "https://example.test/index.htm" });

    const result = await surface.perform({
      kind: "click",
      locator: { role: "button", name: "Log In" },
    });

    expect(result).toEqual({ kind: "ok" });
    expect((await surface.snapshot()).url).toBe("https://example.test/overview.htm");
  });

  it("stays put when a click matches no transition", async () => {
    const surface = new FakeSurface(SCRIPT);
    await surface.perform({ kind: "navigate", url: "https://example.test/overview.htm" });

    const result = await surface.perform({
      kind: "click",
      locator: { role: "link", name: "Home", ordinal: 0 },
    });

    expect(result).toEqual({ kind: "ok" });
    expect((await surface.snapshot()).url).toBe("https://example.test/overview.htm");
  });

  it("reports a Locator that matches nothing, rather than throwing", async () => {
    const surface = new FakeSurface(SCRIPT);
    await surface.perform({ kind: "navigate", url: "https://example.test/index.htm" });

    const locator: Locator = { role: "link", name: "Log Out" };

    expect(await surface.perform({ kind: "click", locator })).toEqual({
      kind: "not-found",
      locator,
    });
  });

  it("reports a Locator that matches several controls, rather than taking the first", async () => {
    const surface = new FakeSurface(SCRIPT);
    await surface.perform({ kind: "navigate", url: "https://example.test/overview.htm" });

    const locator: Locator = { role: "link", name: "Home" };

    expect(await surface.perform({ kind: "click", locator })).toEqual({
      kind: "ambiguous",
      locator,
      matches: 2,
    });
  });

  it("remembers what was typed, so a mistargeted ordinal is visible", async () => {
    // The point of the fake is not that fills succeed — it is that they land
    // where the Locator said. ParaBank's two login inputs are unnamed and told
    // apart by ordinal alone, so this is the check that ordinal means what the
    // real browser means by it.
    const surface = new FakeSurface(SCRIPT);
    await surface.perform({ kind: "navigate", url: "https://example.test/index.htm" });

    await surface.perform({ kind: "fill", locator: { role: "textbox", ordinal: 0 }, value: "typed-value" });

    expect(await surface.perform({ kind: "read", locator: { role: "textbox", ordinal: 0 } })).toEqual(
      { kind: "ok", value: "typed-value" },
    );
    expect(await surface.perform({ kind: "read", locator: { role: "textbox", ordinal: 1 } })).toEqual(
      { kind: "ok", value: "" },
    );
  });

  it("forgets what was typed once the page is left and come back to", async () => {
    const surface = new FakeSurface(SCRIPT);
    await surface.perform({ kind: "navigate", url: "https://example.test/index.htm" });
    await surface.perform({ kind: "fill", locator: { role: "textbox", ordinal: 0 }, value: "typed-value" });

    await surface.perform({ kind: "navigate", url: "https://example.test/overview.htm" });
    await surface.perform({ kind: "navigate", url: "https://example.test/index.htm" });

    expect(await surface.perform({ kind: "read", locator: { role: "textbox", ordinal: 0 } })).toEqual(
      { kind: "ok", value: "" },
    );
  });

  it("reads the accessible name of a control nobody typed into", async () => {
    // The flagship Capability's whole job: the value cell scoped by the row
    // that names the field, because both cells are named for their contents.
    const surface = new FakeSurface(SCRIPT);
    await surface.perform({ kind: "navigate", url: "https://example.test/overview.htm" });

    const result = await surface.perform({
      kind: "read",
      locator: { role: "cell", ordinal: 1, within: { role: "row", name: "Balance:" } },
    });

    expect(result).toEqual({ kind: "ok", value: "-$2300.00" });
  });

  it("chooses an option and reads it back", async () => {
    const surface = new FakeSurface(SCRIPT);
    await surface.perform({ kind: "navigate", url: "https://example.test/overview.htm" });

    const chosen = await surface.perform({
      kind: "select",
      locator: { role: "combobox" },
      option: "Credit",
    });

    expect(chosen).toEqual({ kind: "ok" });
    expect(await surface.perform({ kind: "read", locator: { role: "combobox" } })).toEqual({
      kind: "ok",
      value: "Credit",
    });
  });

  it("reports an option the control does not offer", async () => {
    // A browser refuses this outright. A fake that shrugged and accepted it
    // would pass interactions the real Surface fails, which is the one thing a
    // fake must never do.
    const surface = new FakeSurface(SCRIPT);
    await surface.perform({ kind: "navigate", url: "https://example.test/overview.htm" });

    const result = await surface.perform({
      kind: "select",
      locator: { role: "combobox" },
      option: "Wire",
    });

    expect(result).toEqual({
      kind: "not-found",
      locator: { role: "option", name: "Wire", exact: true, within: { role: "combobox" } },
    });
  });

  it("waits for a control that is there, and reports one that is not", async () => {
    const surface = new FakeSurface(SCRIPT);
    await surface.perform({ kind: "navigate", url: "https://example.test/overview.htm" });

    expect(
      await surface.perform({
        kind: "waitFor",
        locator: { role: "heading", name: "Accounts Overview" },
      }),
    ).toEqual({ kind: "ok" });

    const missing: Locator = { role: "heading", name: "Account Details" };
    expect(await surface.perform({ kind: "waitFor", locator: missing })).toEqual({
      kind: "not-found",
      locator: missing,
    });
  });

  it("fires a once-only transition once, and then the one it was shadowing", async () => {
    // How a script says "transient". Without this the fake can describe an
    // application that is always broken or never broken and nothing in
    // between — and a Recoverable Condition is exactly the state in between.
    const surface = new FakeSurface({
      screens: [
        {
          name: "overview",
          url: "https://example.test/overview.htm",
          tree: `- link "Account"\n`,
          transitions: [
            { when: { kind: "click", locator: { role: "link", name: "Account" } }, to: "login", once: true },
            { when: { kind: "click", locator: { role: "link", name: "Account" } }, to: "detail" },
          ],
        },
        { name: "login", url: "https://example.test/index.htm", tree: `- button "Log In"\n` },
        { name: "detail", url: "https://example.test/activity.htm", tree: `- heading "Detail"\n` },
      ],
    });
    const goToOverview = { kind: "navigate", url: "https://example.test/overview.htm" } as const;
    const openAccount = { kind: "click", locator: { role: "link", name: "Account" } } as const;

    await surface.perform(goToOverview);
    await surface.perform(openAccount);
    expect((await surface.snapshot()).url).toBe("https://example.test/index.htm");

    await surface.perform(goToOverview);
    await surface.perform(openAccount);
    expect((await surface.snapshot()).url).toBe("https://example.test/activity.htm");
  });

  it("takes a screenshot that names the screen, without pretending to be an image", async () => {
    const surface = new FakeSurface(SCRIPT);
    await surface.perform({ kind: "navigate", url: "https://example.test/overview.htm" });

    expect((await surface.screenshot()).toString("utf8")).toContain("overview");
  });

  it("reads the option a control already holds, with nothing chosen in this run", async () => {
    // The browser answers this from the `[selected]` marker in the tree, and so
    // does the fake. Getting it from a DOM property instead is what would make
    // the two disagree the moment nobody had touched the control.
    const surface = new FakeSurface(SCRIPT);
    await surface.perform({ kind: "navigate", url: "https://example.test/overview.htm" });

    expect(await surface.perform({ kind: "read", locator: { role: "combobox" } })).toEqual({
      kind: "ok",
      value: "All",
    });
  });
});

/**
 * An ambiguous Locator is a miss, and a miss does nothing. member-lookup's
 * MULTIPLE_MATCHES rests entirely on this: its `select-member` step clicks
 * `link "Select"`, and on a by-name search that matches several members the
 * locator is ambiguous — so the click misses, the run stays on the results
 * screen, and MULTIPLE_MATCHES holds. If a click ever silently resolved an
 * ambiguous locator to its first match, that same "Select" would click the
 * first candidate, reach a member record, and be reported as SUCCESS with the
 * wrong member — a Hard Failure answered as a success, the worst way for this
 * system to be wrong. These tests pin the invariant at the layer it lives in,
 * so any future move to first-match resolution has to break a test to happen.
 */
describe("FakeSurface rejects ambiguous locators without acting on the first (#34)", () => {
  // A results screen whose two "Select" links each lead to the same transition,
  // so a first-match click would fire it and land on the record — exactly the
  // wrong-member-SUCCESS mistake. The ambiguous click must instead stay put.
  const AMBIGUOUS_SCRIPT: Script = {
    screens: [
      {
        name: "results",
        url: "https://example.test/results.htm",
        tree: [
          `- heading "Search Results"`,
          `- link "Select"`,
          `- link "Select"`,
          `- textbox`,
          `- textbox`,
          `- cell "Ada Lovelace"`,
          `- cell "Ada Lovelace"`,
        ].join("\n"),
        transitions: [
          { when: { kind: "click", locator: { role: "link", name: "Select" } }, to: "record" },
        ],
      },
      {
        name: "record",
        url: "https://example.test/record.htm",
        tree: `- heading "Member Record"\n`,
      },
    ],
  };

  it("a click on a locator matching several controls is ambiguous and fires no transition", async () => {
    const surface = new FakeSurface(AMBIGUOUS_SCRIPT);
    await surface.perform({ kind: "navigate", url: "https://example.test/results.htm" });

    const locator: Locator = { role: "link", name: "Select" };
    const result = await surface.perform({ kind: "click", locator });

    expect(result).toEqual({ kind: "ambiguous", locator, matches: 2 });
    // The invariant that guards wrong-member SUCCESS: the click did not act on
    // the first "Select", so the run never left the results screen.
    expect((await surface.snapshot()).url).toBe("https://example.test/results.htm");
  });

  it("a fill on a locator matching several controls is ambiguous and enters nothing", async () => {
    const surface = new FakeSurface(AMBIGUOUS_SCRIPT);
    await surface.perform({ kind: "navigate", url: "https://example.test/results.htm" });

    const locator: Locator = { role: "textbox" };
    const result = await surface.perform({ kind: "fill", locator, value: "typed-value" });

    expect(result).toEqual({ kind: "ambiguous", locator, matches: 2 });
    // Neither box was written: a fill that missed must not silently land on the
    // first control.
    expect(await surface.perform({ kind: "read", locator: { role: "textbox", ordinal: 0 } })).toEqual(
      { kind: "ok", value: "" },
    );
    expect(await surface.perform({ kind: "read", locator: { role: "textbox", ordinal: 1 } })).toEqual(
      { kind: "ok", value: "" },
    );
  });

  it("a read on a locator matching several controls is ambiguous, not the first value", async () => {
    const surface = new FakeSurface(AMBIGUOUS_SCRIPT);
    await surface.perform({ kind: "navigate", url: "https://example.test/results.htm" });

    const locator: Locator = { role: "cell", name: "Ada Lovelace" };

    expect(await surface.perform({ kind: "read", locator })).toEqual({
      kind: "ambiguous",
      locator,
      matches: 2,
    });
  });
});
