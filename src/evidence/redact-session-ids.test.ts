import { describe, expect, it } from "vitest";
import { redactMeridianSessionId, redactSessionIds } from "./redact-session-ids.js";

describe("redactSessionIds", () => {
  it("masks the session token ParaBank writes into every URL", () => {
    // Verbatim from a captured snapshot of ParaBank's login page.
    const line = `  - /url: about.htm;jsessionid=15B890C3035A82807959F11AF04E28E6`;

    expect(redactSessionIds(line)).toBe(`  - /url: about.htm;jsessionid=[REDACTED]`);
  });

  it("also masks MERIDIAN's SID token, so the one always-on pass covers both surfaces", () => {
    // Verbatim from a captured MERIDIAN tree: the token rides the operator
    // banner row, not the URL. `stripSecrets` calls this on every line to disk,
    // so composing the MERIDIAN redactor in here masks it everywhere at once.
    const line = `      - cell "OPR TELLER1 | BR MAIN-001 | 09/03/2026 17:49:35 | SID 562CADE2"`;

    expect(redactSessionIds(line)).toBe(
      `      - cell "OPR TELLER1 | BR MAIN-001 | 09/03/2026 17:49:35 | SID [REDACTED]"`,
    );
  });
});

describe("redactMeridianSessionId", () => {
  it("masks the SID token where MERIDIAN renders it, in the operator banner", () => {
    // Verbatim from a captured MERIDIAN tree (menu.txt).
    const line = `    - row "OPR TELLER1 | BR MAIN-001 | 09/03/2026 17:49:33 | SID 562CADE2":`;

    expect(redactMeridianSessionId(line)).toBe(
      `    - row "OPR TELLER1 | BR MAIN-001 | 09/03/2026 17:49:33 | SID [REDACTED]":`,
    );
  });

  it("masks the SID token when it rides a URL query, of either case", () => {
    // MERIDIAN's captured trees use clean paths, but a session token that ever
    // reaches a URL is the same Secret and must not land in evidence. A URL
    // param is conventionally lowercase, so the marker is matched either way.
    expect(redactMeridianSessionId("/members/100234?SID=562CADE2&next=transfer")).toBe(
      "/members/100234?SID=[REDACTED]&next=transfer",
    );
    expect(redactMeridianSessionId("/members/100234?sid=562CADE2&next=transfer")).toBe(
      "/members/100234?sid=[REDACTED]&next=transfer",
    );
  });

  it("does not pin to one rendering: a colon or extra whitespace still masks", () => {
    expect(redactMeridianSessionId("SID: 562CADE2")).toBe("SID: [REDACTED]");
    expect(redactMeridianSessionId("SID  562CADE2")).toBe("SID  [REDACTED]");
  });

  it("masks a hyphenated token whole, rather than up to its first punctuation", () => {
    // A Secret has no acceptable partial: `[A-Za-z0-9]` alone would leave the
    // tail after a `-` on disk, so the token class runs over `-` and `_`.
    expect(redactMeridianSessionId("SID 562CADE2-teller_7")).toBe("SID [REDACTED]");
  });

  it("masks an all-letter token, since redaction cannot turn on the token's contents (#32)", () => {
    // The token is a Secret whatever random string it happens to be; a run that
    // mints an all-letter `SID` must be masked exactly like a hex one, or the
    // leak depends on luck.
    expect(redactMeridianSessionId(`SID ABCDEFGH`)).toBe(`SID [REDACTED]`);
  });

  it("masks when whitespace sits before the separator, not only after it (#33)", () => {
    // `SID = 562CADE2` and `SID : 562CADE2` render with a space on the marker
    // side of the separator; the token is the same Secret and must not leak.
    expect(redactMeridianSessionId(`SID = 562CADE2`)).toBe(`SID = [REDACTED]`);
    expect(redactMeridianSessionId(`SID : 562CADE2`)).toBe(`SID : [REDACTED]`);
  });

  it("leaves the ordinary word SID alone, so it never corrupts a diagnostic", () => {
    // This pass runs over every line to disk, including ParaBank error strings
    // that have no SID token at all. A real token contains a digit; the prose
    // word does not, which is what tells them apart.
    expect(redactMeridianSessionId("unknown SID field")).toBe("unknown SID field");
    expect(redactMeridianSessionId("- heading: SIDEBAR")).toBe("- heading: SIDEBAR");
    expect(redactMeridianSessionId("resides inside the console")).toBe(
      "resides inside the console",
    );
  });
});
