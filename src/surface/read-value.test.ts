import { describe, expect, it } from "vitest";
import { readAriaSnapshot, type AriaNode } from "./aria-snapshot.js";
import { capturedMeridianTree } from "./meridian/fake-script.js";
import { readControlValue } from "./read-value.js";
import { resolveLocatorIndices } from "./resolve-locator.js";
import type { Locator } from "./surface.js";

/**
 * A read of a typed-in input's current value returns the value, not the label
 * (ADR 0011, #43). The perceived tree is the live read: Playwright's
 * `ariaSnapshot` carries a control's current value inline — a filled textbox as
 * its text, a combobox as its selected option — so a read resolved against a
 * fresh snapshot answers with what the control now holds, and never reaches for
 * the DOM, which `read-value.ts` warns is where portability quietly breaks.
 *
 * The fixture is the captured MERIDIAN inquiry screen after a search: the
 * "Value:" box holds the number that was typed, and the "Search by:" combobox
 * has "Member Number" chosen.
 */
function only(nodes: readonly AriaNode[], locator: Locator): number {
  const matches = resolveLocatorIndices(nodes, locator);
  expect(matches).toHaveLength(1);
  return matches[0]!;
}

describe("reading a typed-in input's current value from the perceived tree", () => {
  const screen = readAriaSnapshot(capturedMeridianTree("members-unique"));

  it("reads the value typed into the textbox, not the field label", () => {
    const box = only(screen, { role: "textbox" });
    // The typed value, carried inline by the snapshot as the textbox's text.
    // The snapshot YAML quotes a number-like value (`- textbox: "100234"`), and
    // the parser strips those quotes (#47), so the read is the bare value — an
    // exact `toBe`, which an exact read or Checkpoint on 100234 depends on.
    expect(readControlValue(screen, box)).toBe("100234");
    // The label is a sibling cell ("Value:"), never what the read returns.
    expect(readControlValue(screen, box)).not.toBe("Value:");
  });

  it("reads the option chosen in the combobox, not the field label", () => {
    const combobox = only(screen, { role: "combobox" });
    expect(readControlValue(screen, combobox)).toBe("Member Number");
    expect(readControlValue(screen, combobox)).not.toBe("Search by:");
  });
});
