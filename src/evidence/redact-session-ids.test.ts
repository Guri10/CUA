import { describe, expect, it } from "vitest";
import { redactSessionIds } from "./redact-session-ids.js";

describe("redactSessionIds", () => {
  it("masks the session token ParaBank writes into every URL", () => {
    // Verbatim from a captured snapshot of ParaBank's login page.
    const line = `  - /url: about.htm;jsessionid=15B890C3035A82807959F11AF04E28E6`;

    expect(redactSessionIds(line)).toBe(`  - /url: about.htm;jsessionid=[REDACTED]`);
  });
});
