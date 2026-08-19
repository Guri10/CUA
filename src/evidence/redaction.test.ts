import { describe, expect, it } from "vitest";
import { redact, SECRET_MARK, SENSITIVE_MARK, stripSecrets, type Redaction } from "./redaction.js";

/**
 * ADR 0006's three kinds, one describe block each, plus the property that
 * separates them: the flag moves Sensitive and cannot move Secret.
 */
const PASSWORD = "hunter2";
const ACCOUNT = "13344";

function redaction(masking: "on" | "off"): Redaction {
  return { secrets: [PASSWORD], sensitive: [ACCOUNT], masking };
}

describe("Secret", () => {
  it("is replaced wherever it is written", () => {
    expect(redact(redaction("on"), "secret", PASSWORD)).toBe(SECRET_MARK);
  });

  it("is still replaced with masking off, because no flag reaches it", () => {
    expect(redact(redaction("off"), "secret", PASSWORD)).toBe(SECRET_MARK);
  });

  it("reads as a Secret rather than as Sensitive when it fills a Sensitive field", () => {
    // What a `fill` typed is Sensitive by position, and on a login form it is
    // the password. The mark says which promise was kept, so it must not depend
    // on a flag that cannot reach a Secret.
    expect(redact(redaction("on"), "sensitive", PASSWORD)).toBe(SECRET_MARK);
    expect(redact(redaction("off"), "sensitive", PASSWORD)).toBe(SECRET_MARK);
  });

  it("is replaced when it turns up inside a value of another kind", () => {
    // The reason redaction is applied at the boundary rather than at the value:
    // a Secret that got into a field nobody classified still must not land.
    expect(redact(redaction("off"), "plain", `signed in as ${PASSWORD}`)).toBe(
      `signed in as ${SECRET_MARK}`,
    );
    expect(redact(redaction("off"), "sensitive", `typed ${PASSWORD}`)).toBe(`typed ${SECRET_MARK}`);
  });

  it("masks the session token ParaBank carries in its URLs", () => {
    expect(redact(redaction("off"), "plain", "/overview.htm;jsessionid=15B890C3")).toBe(
      "/overview.htm;jsessionid=[REDACTED]",
    );
  });
});

describe("Sensitive", () => {
  it("is masked when redaction is on", () => {
    expect(redact(redaction("on"), "sensitive", "-$2300.00")).toBe(SENSITIVE_MARK);
  });

  it("is written in full when redaction is off", () => {
    expect(redact(redaction("off"), "sensitive", "-$2300.00")).toBe("-$2300.00");
  });

  it("does not mangle a Plain value that merely contains the same digits", () => {
    // A short input is the case that bites: replacing every occurrence of "8"
    // would turn the base URL into `localhost:[SENSITIVE]0[SENSITIVE]0` and
    // leave a machine-readable log that no longer parses as one, having
    // protected nothing. A run's input is substituted into a whole field, so
    // what is matched is a whole run of digits and letters, not any substring.
    const short: Redaction = { secrets: [], sensitive: ["8"], masking: "on" };

    expect(redact(short, "plain", "http://localhost:8080/parabank")).toBe(
      "http://localhost:8080/parabank",
    );
    expect(redact(short, "plain", `click on link "8" (exact)`)).toBe(
      `click on link "[SENSITIVE]" (exact)`,
    );
  });

  it("masks a value with regex punctuation in it as the text it is", () => {
    // Inputs are strings the caller supplied, not patterns.
    const punctuated: Redaction = { secrets: [], sensitive: ["a.c"], masking: "on" };

    expect(redact(punctuated, "plain", "abc")).toBe("abc");
    expect(redact(punctuated, "plain", "a.c")).toBe("[SENSITIVE]");
  });

  it("is masked inside a Plain value that happens to carry one", () => {
    // A Locator's accessible name is Plain — a role and a label — right up
    // until this run substituted an account number into it.
    expect(redact(redaction("on"), "plain", `click on link "${ACCOUNT}"`)).toBe(
      `click on link "${SENSITIVE_MARK}"`,
    );
    expect(redact(redaction("off"), "plain", `click on link "${ACCOUNT}"`)).toBe(
      `click on link "${ACCOUNT}"`,
    );
  });
});

describe("Plain", () => {
  it("is written as it is, with either setting", () => {
    expect(redact(redaction("on"), "plain", "/overview.htm")).toBe("/overview.htm");
    expect(redact(redaction("off"), "plain", "/overview.htm")).toBe("/overview.htm");
  });
});

describe("stripSecrets", () => {
  it("is what every line goes through on its way to disk", () => {
    const line = JSON.stringify({ value: PASSWORD, url: "a.htm;jsessionid=ABC" });

    expect(stripSecrets(redaction("off"), line)).toBe(
      JSON.stringify({ value: SECRET_MARK, url: "a.htm;jsessionid=[REDACTED]" }),
    );
  });

  it("ignores an empty secret rather than replacing between every character", () => {
    // A credential read from an unset variable is "" — which as a search term
    // matches everywhere. It has to be dropped, not applied.
    expect(stripSecrets({ secrets: [""], sensitive: [], masking: "on" }, "abc")).toBe("abc");
  });
});
