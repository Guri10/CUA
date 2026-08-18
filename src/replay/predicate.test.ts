import { describe, expect, it } from "vitest";
import type { Predicate } from "../capability/schema.js";
import { readAriaSnapshot } from "../surface/aria-snapshot.js";
import { capturedTree } from "../surface/parabank/fake-script.js";
import { matchesPredicate } from "./predicate.js";

const overview = readAriaSnapshot(capturedTree("02-accounts-overview"));
const detail = readAriaSnapshot(capturedTree("03-account-detail"));

const onAccountDetail: Predicate = {
  kind: "present",
  locator: { role: "heading", name: { kind: "literal", value: "Account Details" } },
};
const onOverview: Predicate = {
  kind: "present",
  locator: { role: "heading", name: { kind: "literal", value: "Accounts Overview" } },
};

/**
 * A Terminal State is a predicate over the accessibility tree, so recognising
 * one is resolving Locators against a snapshot and combining the answers. The
 * trees here are the ones real ParaBank served.
 */
describe("matching a Terminal State against the screen", () => {
  it("finds a control that is on the screen", () => {
    expect(matchesPredicate(detail, onAccountDetail, {})).toBe(true);
  });

  it("does not find one that is on a different screen", () => {
    expect(matchesPredicate(overview, onAccountDetail, {})).toBe(false);
  });

  it("reads absence as a condition in its own right", () => {
    // This is what makes ACCOUNT_NOT_FOUND a Business Outcome rather than a
    // caught error: "the customer does not hold this account" is a predicate
    // over the tree.
    const noSuchAccount: Predicate = {
      kind: "absent",
      locator: { role: "link", name: { kind: "input", input: "accountId" }, exact: true },
    };

    expect(matchesPredicate(overview, noSuchAccount, { accountId: "99999" })).toBe(true);
    expect(matchesPredicate(overview, noSuchAccount, { accountId: "12345" })).toBe(false);
  });

  it("requires every branch of an `all`", () => {
    const both: Predicate = { kind: "all", of: [onAccountDetail, onOverview] };

    expect(matchesPredicate(detail, both, {})).toBe(false);
    expect(matchesPredicate(detail, { kind: "all", of: [onAccountDetail] }, {})).toBe(true);
  });

  it("requires one branch of an `any`", () => {
    // For the application that shows the same outcome in more than one
    // rendering, rather than declaring that outcome twice under two names.
    const either: Predicate = { kind: "any", of: [onAccountDetail, onOverview] };

    expect(matchesPredicate(detail, either, {})).toBe(true);
    expect(matchesPredicate(overview, either, {})).toBe(true);
    expect(matchesPredicate(readAriaSnapshot(capturedTree("01-login")), either, {})).toBe(false);
  });

  it("matches a value that has arrived rather than a cell that merely exists", () => {
    // The proxy `findings.md` settled on: the accessibility tree cannot say
    // "this control has a value", so a balance cell whose name has picked up a
    // currency symbol stands in for one. Scoped to the row being read, so it
    // cannot be satisfied by some other amount elsewhere on the screen.
    const balanceArrived: Predicate = {
      kind: "present",
      locator: {
        role: "cell",
        name: { kind: "literal", value: "$" },
        within: { role: "row", name: { kind: "literal", value: "Balance:" } },
      },
    };

    expect(matchesPredicate(detail, balanceArrived, {})).toBe(true);
    expect(matchesPredicate(overview, balanceArrived, {})).toBe(false);
  });
});
