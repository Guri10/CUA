import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * ADR 0001 bans CSS and XPath expressions from this codebase outright. The ADR
 * says why the ban is fragile: "Seeing Playwright in the dependency list, a
 * reader will reasonably assume CSS selectors are available and may add one to
 * fix a flaky Locator. That would silently destroy the portability claim this
 * project rests on. The ban is deliberate — enforce it in review."
 *
 * Review is a person remembering. This is the same rule, mechanised, so that a
 * selector added to quiet a flaky Locator fails the suite instead of surviving
 * to become the reason a desktop Surface is impossible.
 */
const BANNED = [
  // Playwright's escape hatches into CSS and XPath.
  { pattern: /\.locator\(/, what: "Playwright's CSS/XPath locator" },
  { pattern: /querySelector/, what: "DOM querySelector" },
  { pattern: /\bcss=/, what: "an explicit css= selector" },
  { pattern: /\bxpath=/, what: "an explicit xpath= selector" },
  { pattern: /\$\$?eval\(/, what: "Playwright's $eval / $$eval" },
  { pattern: /page\.\$\$?\(/, what: "Playwright's $ / $$ selector query" },
  { pattern: /\bwaitForSelector\(/, what: "waitForSelector, which takes a selector string" },
  { pattern: /\bframeLocator\(/, what: "frameLocator, which takes a selector string" },
  // The page-level shorthands all take a selector as their first argument, and
  // are the escape hatch someone reaches for before they reach for `.locator`.
  {
    pattern:
      /\bpage\.(click|dblclick|fill|type|press|check|uncheck|hover|tap|focus|selectOption|setInputFiles|dispatchEvent|textContent|innerText|innerHTML|getAttribute|isVisible|isHidden|isEnabled|isChecked|isDisabled|isEditable|inputValue|dragAndDrop|waitForFunction)\(/,
    what: "a page-level shorthand that takes a selector string",
  },
];

/** This file, which necessarily contains the very patterns it looks for. */
const THIS_FILE = "no-css-or-xpath.test.ts";

function offencesIn(source: string): string[] {
  return BANNED.filter(({ pattern }) => pattern.test(source)).map(({ what }) => what);
}

/**
 * Only the directory's own files when it is the repository root — recursing
 * from there would walk `node_modules`, which is neither ours nor small.
 */
function typescriptFilesUnder(directory: string): string[] {
  return readdirSync(directory, { recursive: directory !== ".", encoding: "utf8" })
    .filter((name) => name.endsWith(".ts") && !name.endsWith(THIS_FILE))
    .map((name) => join(directory, name));
}

describe("ADR 0001: the accessibility tree is the only targeting vocabulary", () => {
  it("recognises a selector when it sees one", async () => {
    // Without this the guard below could pass by finding nothing at all, which
    // is exactly how a check like this rots into decoration.
    expect(offencesIn(`await page.locator(".account-row").click()`)).toEqual([
      "Playwright's CSS/XPath locator",
    ]);
    expect(offencesIn(`page.$$eval("td", read)`)).toContain("Playwright's $eval / $$eval");
    expect(offencesIn(`await page.waitForSelector(".account-row")`)).toContain(
      "waitForSelector, which takes a selector string",
    );
    expect(offencesIn(`await page.click("#loginButton")`)).toContain(
      "a page-level shorthand that takes a selector string",
    );
    expect(offencesIn(`await page.getByRole("button", { name: "Log In" }).click()`)).toEqual([]);
  });

  it("finds no CSS or XPath selector anywhere in the codebase", () => {
    const files = [
      ...typescriptFilesUnder("src"),
      ...typescriptFilesUnder("scripts"),
      // The configs at the root are TypeScript too, and are exactly where a
      // global "just use a selector here" workaround would be tempting to hide.
      ...typescriptFilesUnder("."),
    ];
    expect(files.length).toBeGreaterThan(5);

    const offences = files.flatMap((file) =>
      offencesIn(readFileSync(file, "utf8")).map((what) => `${file}: ${what}`),
    );

    expect(offences).toEqual([]);
  });
});
