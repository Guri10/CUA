import { describe, expect, it } from "vitest";
import { readAriaSnapshot, type AriaNode } from "./aria-snapshot.js";
import { capturedMeridianTree } from "./meridian/fake-script.js";
import { readControlValue } from "./read-value.js";
import { resolveLocatorIndices } from "./resolve-locator.js";
import type { Locator } from "./surface.js";
import { signOnCapability } from "../capability/meridian/sign-on.js";
import { memberLookupCapability } from "../capability/meridian/member-lookup.js";
import { substituteLocator } from "../replay/substitute.js";

/**
 * Parity for the one shared resolver (#40): the authored Locators the Surface
 * acts and reads through must land on the controls their authors meant, counted
 * the way the perceived tree counts. `sign-on.test.ts` and `member-lookup.test.ts`
 * already prove each resolves to exactly one control; this goes further and
 * pins *which* control — the operator box, not the password box; the value cell,
 * not the label beside it — so an ordinal that silently shifted onto the wrong
 * sibling could not pass.
 */
const SIGN_ON_INPUTS = { operator: "teller1", password: "pw", branch: "MAIN-001 - Main Office" } as const;
const LOOKUP_INPUTS = { by: "Member Number", q: "100234" } as const;

/** The Locator a named Step addresses, with its input references filled in. */
function stepLocator(
  capability: ReturnType<typeof signOnCapability>,
  stepId: string,
  inputs: Readonly<Record<string, unknown>>,
): Locator {
  const [base] = capability.recordings;
  if (base === undefined || !("steps" in base)) throw new Error("no base Recording");
  const step = base.steps.find((candidate) => candidate.id === stepId);
  if (step === undefined || !("locator" in step.action)) throw new Error(`no locator Step "${stepId}"`);
  return substituteLocator(step.action.locator, inputs);
}

/** The single index a Locator resolves to, failing the test if it is not unique. */
function only(nodes: readonly AriaNode[], locator: Locator): number {
  const matches = resolveLocatorIndices(nodes, locator);
  expect(matches).toHaveLength(1);
  return matches[0]!;
}

describe("sign-on Locators resolve to the intended controls", () => {
  const signon = readAriaSnapshot(capturedMeridianTree("signon"));

  // The inner label rows are scoped with `exact`, because "Operator ID:" is also
  // a substring of the whole sign-on panel's wrapper row — the very content-name
  // collision ADR 0011 turns on. The authored locators dodge it by counting the
  // two textboxes globally by position; this reference has to say `exact` to pin
  // the one row it means.
  it("fills the operator box that sits in the Operator ID row, not the password box", () => {
    const authored = only(signon, stepLocator(signOnCapability(), "fill-operator", SIGN_ON_INPUTS));
    const intended = only(signon, { role: "textbox", within: { role: "row", name: "Operator ID:", exact: true } });
    expect(authored).toBe(intended);
  });

  it("fills the password box that sits in the Password row", () => {
    const authored = only(signon, stepLocator(signOnCapability(), "fill-password", SIGN_ON_INPUTS));
    const intended = only(signon, { role: "textbox", within: { role: "row", name: "Password:", exact: true } });
    expect(authored).toBe(intended);
  });

  it("chooses the sole branch combobox and it is the branch selector", () => {
    const authored = only(signon, stepLocator(signOnCapability(), "choose-branch", SIGN_ON_INPUTS));
    // There is one combobox on the screen, so the authored ordinal-0 combobox is
    // it; its default-selected option is the value the caller supplies as `branch`.
    const intended = only(signon, { role: "combobox" });
    expect(authored).toBe(intended);
    expect(readControlValue(signon, authored)).toBe("MAIN-001 - Main Office");
  });
});

describe("member-lookup read Locators resolve to the value cells, not the labels", () => {
  const record = readAriaSnapshot(capturedMeridianTree("member-100234"));

  it("reads the member number off the value cell", () => {
    const number = only(record, stepLocator(memberLookupCapability(), "read-number", LOOKUP_INPUTS));
    expect(readControlValue(record, number)).toBe("100234");
    expect(readControlValue(record, number)).not.toBe("Member No.:");
  });

  it("reads the member name off the value cell", () => {
    const name = only(record, stepLocator(memberLookupCapability(), "read-name", LOOKUP_INPUTS));
    expect(readControlValue(record, name)).toBe("Lovelace, Ada");
    expect(readControlValue(record, name)).not.toBe("Name:");
  });
});
