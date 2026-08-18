import { describe, expect, it } from "vitest";
import { readAriaSnapshot, type AriaNode } from "../../surface/aria-snapshot.js";
import { readControlValue } from "../../surface/read-value.js";
import { resolveLocator, resolveLocatorIndices } from "../../surface/resolve-locator.js";
import type { Locator } from "../../surface/surface.js";
import { capabilitySchema, type Expression, type StepLocator } from "../schema.js";
import { jsonSchemaFor } from "../json-schema.js";
import { capabilitiesDir, loadCapability } from "../storage.js";
import { capturedTree } from "../../surface/parabank/fake-script.js";
import {
  accountLookupCapability,
  accountLookupInputs,
  accountLookupOutputs,
} from "./account-lookup.js";

/**
 * The hand-written Capability, checked against the accessibility trees real
 * ParaBank actually served.
 *
 * Nothing here has replayed it — that is #5, against a live browser. What can
 * be checked without one is that it is a valid Capability, that its published
 * Contract is the one its Zod declaration generates, and that every Locator it
 * carries addresses exactly one control on the screen it is aimed at. A
 * Recording written from evidence can still be wrong; a Recording that
 * addresses nothing is wrong now.
 */
describe("the ParaBank account lookup Capability", () => {
  it("validates against the Capability schema", () => {
    const result = capabilitySchema.safeParse(accountLookupCapability());

    expect(result.success).toBe(true);
  });

  it("publishes the JSON Schema Zod generates for its inputs and outputs", () => {
    const { contract } = accountLookupCapability();

    expect(contract.inputs).toEqual(jsonSchemaFor(accountLookupInputs));
    expect(contract.outputs).toEqual(jsonSchemaFor(accountLookupOutputs));
  });

  it("clicks an account link that exists on the captured overview", () => {
    const overview = readAriaSnapshot(capturedTree("02-accounts-overview"));

    expect(resolveLocator(overview, locatorOf("open-account"))).toHaveLength(1);
  });

  it("reads the balance and the account type off the captured account detail", () => {
    const detail = readAriaSnapshot(capturedTree("03-account-detail"));

    expect(valueAt(detail, locatorOf("read-balance"))).toBe("-$2300.00");
    expect(valueAt(detail, locatorOf("read-account-type"))).toBe("CHECKING");
  });

  it("matches success only on the account detail screen", () => {
    const detail = readAriaSnapshot(capturedTree("03-account-detail"));
    const overview = readAriaSnapshot(capturedTree("02-accounts-overview"));
    const success = terminalStateLocators("success");

    expect(success.every((locator) => resolveLocator(detail, locator).length === 1)).toBe(true);
    expect(success.some((locator) => resolveLocator(overview, locator).length === 0)).toBe(true);
  });

  it("is committed as the file a caller actually reads", async () => {
    // The module above is the source; the file is the artefact. They are kept
    // together by `npm run capability:write` and by this test failing when
    // someone edits one and not the other.
    const committed = await loadCapability(capabilitiesDir(), "account-lookup", 1);

    expect(committed).toEqual(accountLookupCapability());
  });

  it("sees no link for an account the customer does not hold", () => {
    // What makes ACCOUNT_NOT_FOUND a Business Outcome rather than a caught
    // error: on the overview screen it is a predicate over the tree.
    const overview = readAriaSnapshot(capturedTree("02-accounts-overview"));
    const [onOverview, accountLink] = terminalStateLocators("ACCOUNT_NOT_FOUND", "99999");

    expect(resolveLocator(overview, onOverview!)).toHaveLength(1);
    expect(resolveLocator(overview, accountLink!)).toHaveLength(0);
  });
});

/** The account the committed snapshots were captured against. */
const CAPTURED_ACCOUNT = "12345";

/** The Locator a named Step addresses, with its input references filled in. */
function locatorOf(stepId: string): Locator {
  const [base] = accountLookupCapability().recordings;
  if (base === undefined || !("steps" in base)) throw new Error("no base Recording");

  const step = base.steps.find((candidate) => candidate.id === stepId);
  if (step === undefined) throw new Error(`no Step "${stepId}"`);
  if (!("locator" in step.action)) throw new Error(`Step "${stepId}" addresses no control`);

  return substitute(step.action.locator, CAPTURED_ACCOUNT);
}

/** Every Locator a Terminal State's predicate rests on, in declaration order. */
function terminalStateLocators(name: string, accountId = CAPTURED_ACCOUNT): Locator[] {
  const state = accountLookupCapability().contract.terminalStates.find(
    (candidate) => (candidate.kind === "success" ? "success" : candidate.name) === name,
  );
  if (state === undefined) throw new Error(`no Terminal State "${name}"`);

  const collect = (predicate: typeof state.when): StepLocator[] =>
    "locator" in predicate ? [predicate.locator] : predicate.of.flatMap(collect);

  return collect(state.when).map((locator) => substitute(locator, accountId));
}

function valueAt(nodes: AriaNode[], locator: Locator): string {
  const [index, ...rest] = resolveLocatorIndices(nodes, locator);
  if (index === undefined || rest.length > 0) {
    throw new Error(`expected exactly one match, got ${rest.length + (index === undefined ? 0 : 1)}`);
  }
  return readControlValue(nodes, index);
}

/**
 * Filling an input reference in, the way #5's executor will at run time. It is
 * here rather than imported because the executor does not exist yet, and a
 * Recording whose Locators have never been resolved against a real tree is not
 * worth committing.
 */
function substitute(locator: StepLocator, accountId: string): Locator {
  const value = (expression: Expression): string =>
    expression.kind === "literal" ? expression.value : accountId;

  return {
    role: locator.role,
    ...(locator.name === undefined ? {} : { name: value(locator.name) }),
    ...(locator.exact === undefined ? {} : { exact: locator.exact }),
    ...(locator.ordinal === undefined ? {} : { ordinal: locator.ordinal }),
    ...(locator.within === undefined ? {} : { within: substitute(locator.within, accountId) }),
  };
}
