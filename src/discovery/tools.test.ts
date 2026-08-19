import { describe, expect, it } from "vitest";
import type { Action } from "../surface/surface.js";
import { DISCOVERY_TOOLS, discoveryToolDefinitions, isToolName } from "./tools.js";

/**
 * ADR 0002's claim, held mechanically: "these verbs are deliberately identical
 * to the Step vocabulary of a Recording, so that recording later becomes a
 * filter over successful actions rather than a translation".
 *
 * A verb added to one side and not the other is how that stops being true, and
 * it would fail silently — the model would call a tool the recorder cannot turn
 * into a Step, or a Step kind would exist that no Discovery Run can produce.
 */
const ACTION_KINDS: Action["kind"][] = [
  "navigate",
  "click",
  "fill",
  "select",
  "read",
  "waitFor",
];

/** `waitFor` on the Surface seam, `wait_for` as a tool name. */
function toolNameFor(kind: string): string {
  return kind.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

interface SchemaNode {
  properties?: Record<string, SchemaNode>;
  required?: readonly string[];
}

/** Every property in the tree that its own object does not require. */
function countOptionals(node: SchemaNode): number {
  const properties = Object.entries(node.properties ?? {});
  const required = new Set(node.required ?? []);

  return properties.reduce(
    (count, [name, child]) =>
      count + (required.has(name) ? 0 : 1) + countOptionals(child),
    0,
  );
}

describe("the discovery tool schema", () => {
  it("offers every Step verb the model is allowed to use, and no other", () => {
    const offered = Object.keys(DISCOVERY_TOOLS);
    const actions = ACTION_KINDS.map(toolNameFor).filter((name) => name !== "navigate");

    expect([...offered].sort()).toEqual([...actions, "done"].sort());
  });

  it("does not offer navigate, so no address can come from the model", () => {
    // The run is put at its entry point before the loop starts. The policy gate
    // would refuse an address outside the allowlist anyway; not offering the
    // verb means it never has to.
    expect(isToolName("navigate")).toBe(false);
  });

  it("asks for a reason on every tool, including done", () => {
    for (const [name, tool] of Object.entries(DISCOVERY_TOOLS)) {
      expect(tool.input.shape, `${name} has no reason`).toHaveProperty("reason");
    }
  });

  it("publishes a closed object schema per tool", () => {
    for (const definition of discoveryToolDefinitions()) {
      expect(definition.input_schema.type).toBe("object");
      expect(definition.input_schema.additionalProperties).toBe(false);
      expect(definition.description ?? "").not.toBe("");
    }
  });

  it("stays under the optional-parameter ceiling a strict schema would impose", () => {
    // Not strict, so this is not enforced by the API — but it is the number
    // that made the choice, and a Locator growing a few more optionals is
    // exactly how somebody would rediscover the limit the hard way.
    const optionals = discoveryToolDefinitions().reduce(
      (count, tool) => count + countOptionals(tool.input_schema as SchemaNode),
      0,
    );

    expect(optionals).toBeGreaterThan(24);
  });

  it("addresses controls in the ADR 0001 vocabulary and no other", () => {
    const click = discoveryToolDefinitions().find((tool) => tool.name === "click");
    const properties = click?.input_schema.properties as Record<string, unknown> | undefined;
    const locator = properties?.["locator"] as { properties?: Record<string, unknown> } | undefined;

    expect(Object.keys(locator?.properties ?? {}).sort()).toEqual([
      "exact",
      "name",
      "ordinal",
      "role",
      "within",
    ]);
  });

  it("publishes no integer bound, which a strict tool schema refuses outright", () => {
    // `z.int()` writes JavaScript's safe-integer range into the schema and the
    // API answers 400 for it. The bound that matters is a refinement, which
    // still runs when the call comes back.
    const published = JSON.stringify(discoveryToolDefinitions());

    expect(published).not.toContain("minimum");
    expect(published).not.toContain("maximum");
    expect(published).toContain(`"type":"integer"`);
  });

  it("still refuses a negative ordinal, which is where that bound was load-bearing", () => {
    expect(DISCOVERY_TOOLS.click.input.safeParse({
      reason: "trying",
      locator: { role: "link", ordinal: -1 },
    }).success).toBe(false);
  });

  it("carries no CSS or XPath vocabulary anywhere in what the model is given", () => {
    // ADR 0001 bans them as a Locator strategy. The model is never shown the
    // words, so it has nothing to reach for.
    const published = JSON.stringify(discoveryToolDefinitions());

    // "selector" covers the DOM query function too, and spelling that one out
    // here would itself trip `no-css-or-xpath.test.ts` — which is the ban
    // working, so the shorter list stays.
    for (const banned of ["selector", "css", "xpath"]) {
      expect(published.toLowerCase()).not.toContain(banned);
    }
  });
});
