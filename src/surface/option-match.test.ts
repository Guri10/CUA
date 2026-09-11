import { describe, expect, it } from "vitest";
import { optionMatches } from "./option-match.js";

const SHARE_LABEL = "100234-S0001-12 - Regular Shares ($50.00)";

describe("optionMatches", () => {
  it("accepts an exact label, so an undecorated option keeps binding as before", () => {
    expect(optionMatches("SAVINGS", "SAVINGS")).toBe(true);
    expect(optionMatches(SHARE_LABEL, SHARE_LABEL)).toBe(true);
  });

  it("accepts a stable id the label decorates with a type and a live balance", () => {
    expect(optionMatches(SHARE_LABEL, "100234-S0001-12")).toBe(true);
  });

  it("is unaffected by the balance drifting, since it never reads past the id", () => {
    expect(optionMatches("100234-S0001-12 - Regular Shares ($3.00)", "100234-S0001-12")).toBe(true);
  });

  it("requires a word boundary, so a shorter id does not match a longer one", () => {
    // The character after "100234-S0001-1" in the label is "2", not a space.
    expect(optionMatches(SHARE_LABEL, "100234-S0001-1")).toBe(false);
  });

  it("does not match on a substring in the middle of the label", () => {
    expect(optionMatches(SHARE_LABEL, "Regular Shares")).toBe(false);
    expect(optionMatches(SHARE_LABEL, "S0001-12")).toBe(false);
  });

  it("ignores case and surrounding whitespace", () => {
    expect(optionMatches("  MMKT - Money Market  ", "mmkt")).toBe(true);
  });

  it("never matches an empty value, the blank a caller left an optional field", () => {
    expect(optionMatches(SHARE_LABEL, "")).toBe(false);
    expect(optionMatches("", "")).toBe(false);
  });
});
