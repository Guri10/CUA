import { describe, expect, it } from "vitest";
import { accountLookupCapability } from "../capability/parabank/account-lookup.js";
import type { JsonSchemaObject } from "../capability/schema.js";
import { coerceTextValues, parseContractValues } from "./contract-values.js";

const { contract } = accountLookupCapability();

/** A Contract declaring something other than a string, which ParaBank's does not. */
const typed: JsonSchemaObject = {
  type: "object",
  properties: {
    accountId: { type: "string" },
    limit: { type: "integer" },
    includeClosed: { type: "boolean" },
  },
  required: ["accountId"],
};

/**
 * The Contract as the boundary it is: a caller's inputs are checked against it
 * before anything touches a screen, and the values a run extracted are checked
 * against it before they are handed back.
 *
 * The schema is JSON Schema in the file rather than a Zod declaration, because
 * a calling agent reads a Contract without importing any code. Zod reads it
 * back the other way, so there is still one validator rather than two with
 * their own opinions.
 */
describe("checking values against a Contract", () => {
  it("accepts the inputs the Contract declares", () => {
    expect(parseContractValues(contract.inputs, { accountId: "12345" }, "This run's inputs")).toEqual(
      { accountId: "12345" },
    );
  });

  it("names the Contract and the field when an input is missing", () => {
    expect(() => parseContractValues(contract.inputs, {}, "This run's inputs")).toThrow(
      /This run's inputs[\s\S]*accountId/,
    );
  });

  it("refuses an input the Contract does not declare", () => {
    // A misspelled input that was quietly ignored would run the Recording with
    // the blank unfilled, which fails much later and much less clearly.
    expect(() =>
      parseContractValues(contract.inputs, { accountID: "12345" }, "This run's inputs"),
    ).toThrow(/accountID/);
  });

  it("refuses an input of the wrong type", () => {
    expect(() =>
      parseContractValues(contract.inputs, { accountId: 12345 }, "This run's inputs"),
    ).toThrow(/accountId/);
  });

  it("accepts the outputs a successful run extracted", () => {
    const outputs = { accountType: "CHECKING", balance: "-$2300.00" };

    expect(parseContractValues(contract.outputs, outputs, "This run's outputs")).toEqual(outputs);
  });

  it("coerces text to the types the Contract declares", () => {
    // Everything arrives as text — a command line argument, or the accessible
    // name of a control that was read — and the Contract is what says what it
    // means.
    expect(
      coerceTextValues(typed, { accountId: "12345", limit: "10", includeClosed: "true" }, "input"),
    ).toEqual({ accountId: "12345", limit: 10, includeClosed: true });
  });

  it("says which field failed to coerce rather than passing NaN on", () => {
    expect(() => coerceTextValues(typed, { limit: "ten" }, "input")).toThrow(/limit[\s\S]*ten/);
  });

  it("refuses to guess at a declared type it cannot read out of text", () => {
    // A read returns the text of a control. Turning that into an object would
    // be inventing structure that was never on the screen.
    const nested: JsonSchemaObject = { type: "object", properties: { rows: { type: "array" } } };

    expect(() => coerceTextValues(nested, { rows: "a, b, c" }, "output")).toThrow(/rows/);
  });

  it("passes a field the Contract does not declare through untouched", () => {
    // Coercion has nothing to say about it; `parseContractValues` is what
    // refuses it, and it should be the thing that reports it.
    expect(coerceTextValues(typed, { nope: "1" }, "input")).toEqual({ nope: "1" });
  });
});
