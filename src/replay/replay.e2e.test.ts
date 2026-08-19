import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { accountLookupCapability } from "../capability/parabank/account-lookup.js";
import { headless } from "../surface/headless.js";
import { logInToParabank } from "../surface/parabank/login.js";
import { PlaywrightSurface } from "../surface/playwright-surface.js";
import { replayCapability } from "./replay.js";

/**
 * The tracer bullet against the real thing: the committed lookup Capability,
 * replayed through a real browser against a running ParaBank, with no model
 * anywhere on the path.
 *
 * `replay.test.ts` runs the same executor against the scripted fake and proves
 * the Locators address the controls the capture recorded. Only this can say the
 * application still serves those controls today.
 *
 * Needs ParaBank up — `npm run parabank:start` — and credentials in `.env`.
 */
const BASE_URL = process.env["PARABANK_BASE_URL"] ?? "http://localhost:8080/parabank";
const USERNAME = required("PARABANK_USERNAME");
const PASSWORD = required("PARABANK_PASSWORD");

/** ADR 0006 classes the password a Secret: no default, no literal, no fallback. */
function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`${name} is not set. Copy .env.example to .env and fill it in.`);
  }
  return value;
}

describe("replaying the lookup Capability against real ParaBank", () => {
  let surface: PlaywrightSurface;
  /**
   * Read off the running application rather than hard-coded: the container
   * seeds a different set of account numbers into every fresh instance, so an
   * account number belongs to the installation and not to the Capability.
   */
  let accountId: string;

  beforeAll(async () => {
    surface = await PlaywrightSurface.launch({ headless: headless() });

    // Signing in is the caller's job, exactly as it is in the CLI. The executor
    // is handed a Surface that already has a session and knows nothing about
    // how it got one, which is what keeps login out of every Recording.
    for (const action of logInToParabank(BASE_URL, { username: USERNAME, password: PASSWORD })) {
      expect(await surface.perform(action)).toEqual({ kind: "ok" });
    }

    const overview = await surface.snapshot();
    const account = overview.nodes.find(
      (node) => node.role === "link" && /^\d+$/.test(node.name ?? ""),
    );
    expect(account?.name).toBeDefined();
    accountId = account!.name!;
  });

  afterAll(async () => {
    await surface.close();
  });

  it("returns the account's type and balance as the Contract declares them", async () => {
    const result = await replayCapability(
      surface,
      accountLookupCapability(),
      { accountId },
      { baseUrl: BASE_URL },
    );

    expect(result).toMatchObject({ kind: "success" });
    if (result.kind !== "success") return;

    // Not an exact value: the container seeds its own balances, so what can be
    // asserted is the shape the Contract promises and nothing more.
    expect(result.outputs["accountType"]).toMatch(/^(CHECKING|SAVINGS)$/);
    expect(result.outputs["balance"]).toMatch(/^-?\$[\d,]+\.\d{2}$/);
  });

  it("runs the same Recording for a different account", async () => {
    // The whole point of an Expression: one Recording, any account. Replaying
    // twice with different inputs against the same live session is where that
    // either holds or does not.
    const overview = await surface.perform({
      kind: "navigate",
      url: `${BASE_URL}/overview.htm`,
    });
    expect(overview).toEqual({ kind: "ok" });
    await surface.perform({ kind: "waitFor", locator: { role: "row", name: "$", ordinal: 0 } });

    const numbers = (await surface.snapshot()).nodes
      .filter((node) => node.role === "link" && /^\d+$/.test(node.name ?? ""))
      .map((node) => node.name!);
    const second = numbers.find((number) => number !== accountId);
    expect(second).toBeDefined();

    const result = await replayCapability(
      surface,
      accountLookupCapability(),
      { accountId: second! },
      { baseUrl: BASE_URL },
    );

    expect(result).toMatchObject({ kind: "success" });
  });

  it("refuses inputs the Contract does not accept before it touches the screen", async () => {
    await expect(
      replayCapability(surface, accountLookupCapability(), {}, { baseUrl: BASE_URL }),
    ).rejects.toThrow(/accountId/);
  });

  it("stops rather than reporting success for an account the customer does not hold", async () => {
    // #6 is where this becomes the Capability's declared ACCOUNT_NOT_FOUND
    // Business Outcome, matched against this same real response. What matters
    // here is that it does not quietly succeed.
    const result = await replayCapability(
      surface,
      accountLookupCapability(),
      { accountId: "99999999" },
      { baseUrl: BASE_URL },
    );

    expect(result).toMatchObject({
      kind: "hard-failure",
      step: "open-account",
      observed: "no control matched",
    });
  });
});
