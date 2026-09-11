import { describe, expect, it } from "vitest";
import { redact, SECRET_MARK, SENSITIVE_MARK, stripSecrets, type Redaction } from "./redaction.js";

/**
 * The MERIDIAN surface's data classification, as an executable list of what
 * lands in each of ADR 0006's three kinds. The mechanism is the same one
 * ParaBank uses — nothing here is surface-specific code — so this file is the
 * record that MERIDIAN's fields fall the way the ticket requires: the operator
 * password and SID token are Secret, member data is Sensitive, and routes and
 * step names are Plain.
 *
 * Secret by value (the operator password) and Sensitive by value (this run's
 * own inputs, substituted into Locators) are listed here. What a `read` returns
 * — a balance, a name — is Sensitive by *position* and classified where the
 * result is logged (`classify-action.ts`), so it is exercised here through the
 * same `redact(…, "sensitive", …)` call that layer makes.
 */
const OPERATOR_PASSWORD = "t3ller-pw";
const MEMBER_NUMBER = "100234";

/** Sensitive values MERIDIAN reads off the screen, verbatim from captured trees. */
const MEMBER_DATA = {
  "member number": "100234",
  "share id": "100234-S0070",
  balance: "$1,240.55",
  name: "Dana Whitfield",
  email: "dana.whitfield@example.com",
  phone: "555-0142",
  address: "48 Coral Row, Apt 6",
} as const;

function redaction(masking: "on" | "off"): Redaction {
  return { secrets: [OPERATOR_PASSWORD], sensitive: [MEMBER_NUMBER], masking };
}

describe("MERIDIAN Secret", () => {
  it("never writes the operator password, under either masking setting", () => {
    expect(redact(redaction("on"), "secret", OPERATOR_PASSWORD)).toBe(SECRET_MARK);
    expect(redact(redaction("off"), "secret", OPERATOR_PASSWORD)).toBe(SECRET_MARK);
  });

  it("strips the operator password out of a Plain line it leaked into", () => {
    // The always-on pass: a Secret that reached a field nobody classified is
    // still not written, whatever the flag says.
    expect(redact(redaction("off"), "plain", `signed on as OPR with ${OPERATOR_PASSWORD}`)).toBe(
      `signed on as OPR with ${SECRET_MARK}`,
    );
  });

  it("never writes the SID session token, from the banner row it rides", () => {
    // Verbatim from a captured MERIDIAN tree; `stripSecrets` is what every line
    // to disk goes through, and the SID redactor lives inside it.
    const banner = `cell "OPR TELLER1 | BR MAIN-001 | 09/03/2026 17:49:35 | SID 562CADE2"`;

    expect(stripSecrets(redaction("off"), banner)).toBe(
      `cell "OPR TELLER1 | BR MAIN-001 | 09/03/2026 17:49:35 | SID [REDACTED]"`,
    );
  });
});

describe("MERIDIAN Sensitive", () => {
  it("masks member data in stored evidence when masking is on", () => {
    for (const [field, value] of Object.entries(MEMBER_DATA)) {
      expect(redact(redaction("on"), "sensitive", value), field).toBe(SENSITIVE_MARK);
    }
  });

  it("writes member data in full when masking is off, so a reviewer can verify a run", () => {
    for (const [field, value] of Object.entries(MEMBER_DATA)) {
      expect(redact(redaction("off"), "sensitive", value), field).toBe(value);
    }
  });

  it("masks the member number where it was substituted into a Plain Locator name", () => {
    // The run's own input turns a Plain accessible name Sensitive once it is in
    // it, and is matched as a whole token so a longer id is not half-eaten.
    expect(redact(redaction("on"), "plain", `click on link "${MEMBER_NUMBER}"`)).toBe(
      `click on link "${SENSITIVE_MARK}"`,
    );
    expect(redact(redaction("off"), "plain", `click on link "${MEMBER_NUMBER}"`)).toBe(
      `click on link "${MEMBER_NUMBER}"`,
    );
  });
});

describe("MERIDIAN Plain", () => {
  it("always writes routes, step names, and timings, under either setting", () => {
    // MERIDIAN's clean paths and step labels carry no secret and are the record
    // a reviewer reads to see what a run did. Routes verbatim from captured
    // trees. A route that embeds the member number is the one exception — that
    // value is masked as a whole token, exactly as it is inside a Locator name —
    // so the routes checked here carry the run's inputs in the query, not the
    // path, which is how the read-only routes render.
    for (const masking of ["on", "off"] as const) {
      expect(redact(redaction(masking), "plain", "/members?next=transfer")).toBe(
        "/members?next=transfer",
      );
      expect(redact(redaction(masking), "plain", "/signoff")).toBe("/signoff");
      expect(redact(redaction(masking), "plain", "fill amount")).toBe("fill amount");
      expect(redact(redaction(masking), "plain", "step took 412ms")).toBe("step took 412ms");
    }
  });
});
