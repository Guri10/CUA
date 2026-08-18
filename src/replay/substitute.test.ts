import { describe, expect, it } from "vitest";
import type { StepAction, StepLocator } from "../capability/schema.js";
import { substituteAction, substituteLocator } from "./substitute.js";

const BASE_URL = "http://localhost:8080/parabank";

/**
 * Filling a Recording's blanks in, which is the thing that lets one Recording
 * serve any account rather than the one it was recorded against.
 */
describe("substituting a run's inputs into a Recording", () => {
  it("resolves an input reference in a Locator's name", () => {
    const locator: StepLocator = {
      role: "link",
      name: { kind: "input", input: "accountId" },
      exact: true,
    };

    expect(substituteLocator(locator, { accountId: "12345" })).toEqual({
      role: "link",
      name: "12345",
      exact: true,
    });
  });

  it("leaves a literal alone and keeps a nested scope", () => {
    const locator: StepLocator = {
      role: "cell",
      ordinal: 1,
      within: { role: "row", name: { kind: "literal", value: "Balance:" } },
    };

    expect(substituteLocator(locator, {})).toEqual({
      role: "cell",
      ordinal: 1,
      within: { role: "row", name: "Balance:" },
    });
  });

  it("refuses a reference to an input the run was not given", () => {
    const locator: StepLocator = { role: "link", name: { kind: "input", input: "accountId" } };

    expect(() => substituteLocator(locator, {})).toThrow(/accountId/);
  });

  it("joins a navigate Step's path onto the Surface's origin", () => {
    // A Recording stores a path, never a URL: the origin belongs to the Surface
    // profile, so a Recording carrying one would be tied to the installation it
    // was recorded against.
    const action: StepAction = { kind: "navigate", url: { kind: "literal", value: "/overview.htm" } };

    expect(substituteAction(action, {}, BASE_URL)).toEqual({
      kind: "navigate",
      url: `${BASE_URL}/overview.htm`,
    });
  });

  it("refuses a navigate Step that carries an origin of its own", () => {
    const action: StepAction = {
      kind: "navigate",
      url: { kind: "literal", value: "http://localhost:8080/parabank/overview.htm" },
    };

    expect(() => substituteAction(action, {}, BASE_URL)).toThrow(/path/);
  });

  it("carries a fill Step's value through", () => {
    const action: StepAction = {
      kind: "fill",
      locator: { role: "textbox", ordinal: 0 },
      value: { kind: "input", input: "accountId" },
    };

    expect(substituteAction(action, { accountId: "12345" }, BASE_URL)).toEqual({
      kind: "fill",
      locator: { role: "textbox", ordinal: 0 },
      value: "12345",
    });
  });

  it("drops a read Step's output binding, which is not the Surface's business", () => {
    // `bind` says which Contract output the value becomes. The Surface only
    // needs to know which control to read.
    const action: StepAction = {
      kind: "read",
      locator: { role: "cell", ordinal: 1 },
      bind: "balance",
    };

    expect(substituteAction(action, {}, BASE_URL)).toEqual({
      kind: "read",
      locator: { role: "cell", ordinal: 1 },
    });
  });

  it("keeps a waitFor Step's timeout", () => {
    const action: StepAction = {
      kind: "waitFor",
      locator: { role: "row", name: { kind: "literal", value: "$" }, ordinal: 0 },
      timeoutMs: 2_000,
    };

    expect(substituteAction(action, {}, BASE_URL)).toEqual({
      kind: "waitFor",
      locator: { role: "row", name: "$", ordinal: 0 },
      timeoutMs: 2_000,
    });
  });

  it("renders a non-string input as the text a control would carry", () => {
    // A Contract may declare a number; a control's accessible name is text.
    const locator: StepLocator = { role: "link", name: { kind: "input", input: "accountId" } };

    expect(substituteLocator(locator, { accountId: 12345 })).toEqual({
      role: "link",
      name: "12345",
    });
  });
});
