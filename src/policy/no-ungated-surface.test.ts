import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * "No path exists to obtain an ungated Surface."
 *
 * The policy gate is a decorator, which makes it impossible to forget only for
 * as long as there is no way round it. One `PlaywrightSurface.launch()` in a
 * new command, or one `chromium.launch()` in a helper, and every guarantee ADR
 * 0007 makes becomes a thing that is true of most code paths — which is not a
 * guarantee at all, and would fail silently.
 *
 * So the rule is mechanised the same way ADR 0001's selector ban is. Only the
 * modules whose job is to build a Surface may name one.
 */
const MAY_BUILD_A_SURFACE = [
  // The implementations themselves, and the fake's scripted screens.
  "src/surface/",
  // The one factory, which returns them already wrapped.
  "src/policy/open-surface.ts",
];

const BANNED = [
  { pattern: /\bPlaywrightSurface\b/, what: "the browser Surface, built directly" },
  { pattern: /\bnew FakeSurface\b/, what: "the fake Surface, built directly" },
  { pattern: /from "playwright"/, what: "the browser driver, reached directly" },
];

/** Production modules only. A test may build whatever it is testing. */
function productionFilesUnder(directory: string): string[] {
  return readdirSync(directory, { recursive: true, encoding: "utf8" })
    .filter((name) => name.endsWith(".ts") && !name.includes(".test."))
    .map((name) => join(directory, name))
    .filter((path) => !MAY_BUILD_A_SURFACE.some((allowed) => path.startsWith(allowed)));
}

function offencesIn(source: string): string[] {
  return BANNED.filter(({ pattern }) => pattern.test(source)).map(({ what }) => what);
}

describe("ADR 0007: one gate, both phases", () => {
  it("recognises a way round the gate when it sees one", () => {
    // Without this the check below could pass by finding nothing at all.
    expect(offencesIn(`const s = await PlaywrightSurface.launch()`)).toEqual([
      "the browser Surface, built directly",
    ]);
    expect(offencesIn(`const s = new FakeSurface(script)`)).toEqual([
      "the fake Surface, built directly",
    ]);
    expect(offencesIn(`import { chromium } from "playwright"`)).toEqual([
      "the browser driver, reached directly",
    ]);
    expect(offencesIn(`const { surface } = await openBrowserSurface(profile, mandate)`)).toEqual([]);
  });

  it("finds no way to reach a screen without passing the gate", () => {
    const files = productionFilesUnder("src");
    expect(files.length).toBeGreaterThan(5);
    // The command that drives the application is the file this is really about.
    expect(files).toContain("src/cli.ts");

    const offences = files.flatMap((file) =>
      offencesIn(readFileSync(file, "utf8")).map((what) => `${file}: ${what}`),
    );

    expect(offences).toEqual([]);
  });
});
