import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The whole point of the system: the replay path runs with no model in it.
 *
 * That is easy to state and easy to lose. A convenience import added to "just
 * ask the model when a Locator misses" would keep every test passing while
 * quietly making replay non-deterministic and paid-for — the two properties
 * this project exists to provide.
 *
 * So the claim is checked the only way it can be: by walking what the executor
 * actually imports, transitively, and finding nothing that can call anything.
 */
const ENTRY = "src/replay/replay.ts";

/** A dependency that could reach a model, by name. */
const MODEL_PACKAGES = /^(@anthropic-ai\/|@ai-sdk\/|anthropic|openai|@openai\/|langchain|@langchain\/|ollama|@google\/gener)/;

/** Every module the entry point pulls in, transitively, by path. */
function moduleGraphFrom(entry: string): string[] {
  const seen = new Set<string>();
  const queue = [resolve(entry)];

  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);

    for (const specifier of importsIn(readFileSync(file, "utf8"))) {
      if (!specifier.startsWith(".")) continue;
      // Written `.js` for the runtime, kept `.ts` on disk.
      const target = join(dirname(file), specifier.replace(/\.js$/, ".ts"));
      if (existsSync(target)) queue.push(target);
    }
  }

  return [...seen];
}

/** Static imports, re-exports, and dynamic ones — a model client could arrive as any. */
function importsIn(source: string): string[] {
  return [...source.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)].map((match) => match[1]!);
}

function packagesIn(files: string[]): string[] {
  const packages = files.flatMap((file) =>
    importsIn(readFileSync(file, "utf8")).filter((specifier) => !specifier.startsWith(".")),
  );
  return [...new Set(packages)].sort();
}

describe("the replay path", () => {
  it("has a module graph the walk actually reaches", () => {
    // Without this the check below could pass by reading nothing at all, which
    // is how a guard like this rots into decoration.
    const graph = moduleGraphFrom(ENTRY);

    expect(graph.length).toBeGreaterThan(5);
    expect(graph.some((file) => file.endsWith("surface.ts"))).toBe(true);
    expect(packagesIn(graph)).toContain("zod");
  });

  it("recognises a model client when it sees one", () => {
    expect(MODEL_PACKAGES.test("@anthropic-ai/sdk")).toBe(true);
    expect(MODEL_PACKAGES.test("openai")).toBe(true);
    expect(MODEL_PACKAGES.test("zod")).toBe(false);
    expect(MODEL_PACKAGES.test("playwright")).toBe(false);
  });

  it("imports nothing that could call a model", () => {
    const offenders = packagesIn(moduleGraphFrom(ENTRY)).filter((name) => MODEL_PACKAGES.test(name));

    expect(offenders).toEqual([]);
  });

  it("reads no model credential", () => {
    // A key read on this path would mean something on it intends to make a
    // call, whichever client eventually gets used to make it.
    const offenders = moduleGraphFrom(ENTRY).filter((file) =>
      /ANTHROPIC_API_KEY|OPENAI_API_KEY/.test(readFileSync(file, "utf8")),
    );

    expect(offenders).toEqual([]);
  });
});
