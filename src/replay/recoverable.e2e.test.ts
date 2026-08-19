import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { accountLookupCapability } from "../capability/parabank/account-lookup.js";
import { loadSurfaceProfile, surfacesDir, type SurfaceProfile } from "../policy/profile.js";
import { headless } from "../surface/headless.js";
import {
  delayEveryResponse,
  expireSessionOnce,
  failWithServerError,
} from "../surface/parabank/fixtures.js";
import { logInToParabank } from "../surface/parabank/login.js";
import { PlaywrightSurface } from "../surface/playwright-surface.js";
import { replayCapability } from "./replay.js";

/**
 * ADR 0005's three classes, against the running application.
 *
 * `recoverable.test.ts` runs the same executor against a scripted fake and
 * proves the logic; only this can say what ParaBank actually does when the
 * response it was about to serve is replaced or held up. The interruptions are
 * injected by intercepting requests — the layer below the browser, so that
 * everything above it, the accessibility tree included, sees exactly what it
 * would see on the day it happens for real.
 *
 * The Business Outcome is not injected and is not here. An account nobody holds
 * is a question ParaBank can simply be asked, and `replay.e2e.test.ts` asks it.
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

/**
 * Shorter than the Surface's own default, because two of these tests are
 * waiting for a control that will never arrive and the wait is the test's
 * running time. Still far longer than the delay injected below.
 */
const TIMEOUT_MS = 5_000;

describe("interruptions injected into a real ParaBank session", () => {
  let browser: Browser;
  /** Held directly, because interception is a property of the page below the Surface. */
  let page: Page;
  let surface: PlaywrightSurface;
  let profile: SurfaceProfile;
  /** Read off the running application: every fresh container seeds its own. */
  let accountId: string;

  async function signIn(): Promise<void> {
    for (const action of logInToParabank(BASE_URL, { username: USERNAME, password: PASSWORD })) {
      expect(await surface.perform(action)).toEqual({ kind: "ok" });
    }
  }

  beforeAll(async () => {
    browser = await chromium.launch({ headless: headless() });
    page = await browser.newPage();
    surface = new PlaywrightSurface(page, { defaultTimeoutMs: TIMEOUT_MS });
    profile = await loadSurfaceProfile(surfacesDir(), "parabank");

    await signIn();

    const account = (await surface.snapshot()).nodes.find(
      (node) => node.role === "link" && /^\d+$/.test(node.name ?? ""),
    );
    expect(account?.name).toBeDefined();
    accountId = account!.name!;
  });

  afterAll(async () => {
    await browser.close();
  });

  it("absorbs a session that expires on the way to the account detail", async () => {
    // The condition is the one the committed profile declares, matched against
    // the screen ParaBank itself serves a caller with no session.
    const stop = await expireSessionOnce(page, { baseUrl: BASE_URL, path: "/activity.htm" });
    let signedInAgain = 0;

    try {
      const result = await replayCapability(
        surface,
        accountLookupCapability(),
        { accountId },
        {
          baseUrl: BASE_URL,
          recoverableConditions: profile.recoverableConditions,
          reestablishSession: async () => {
            signedInAgain += 1;
            await signIn();
          },
        },
      );

      expect(result).toMatchObject({ kind: "success" });
      // Without this the test would pass on an injection that did nothing at
      // all, which is the failure mode every fixture has.
      expect(signedInAgain).toBe(1);
    } finally {
      await stop();
    }
  });

  it("waits out a slow response rather than reading it as a failure", async () => {
    // Nothing is declared for this and nothing needs to be: latency is absorbed
    // by the Step that is waiting for a control, which is where the wait lives
    // and where its timeout is declared.
    const delayMs = 1_500;
    const stop = await delayEveryResponse(page, { ms: delayMs });
    const startedAt = Date.now();

    try {
      const result = await replayCapability(surface, accountLookupCapability(), { accountId }, {
        baseUrl: BASE_URL,
        recoverableConditions: profile.recoverableConditions,
      });

      expect(result).toMatchObject({ kind: "success" });
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(delayMs);
    } finally {
      await stop();
    }
  });

  it("stops on a server error no profile describes", async () => {
    // The third class, and the one that has to remain the default. A screen
    // matching no Terminal State and no Recoverable Condition stops the run and
    // says which Step, what was expected, and what was seen instead.
    const stop = await failWithServerError(page, { path: "/overview.htm" });

    try {
      const result = await replayCapability(surface, accountLookupCapability(), { accountId }, {
        baseUrl: BASE_URL,
        recoverableConditions: profile.recoverableConditions,
      });

      expect(result).toMatchObject({
        kind: "hard-failure",
        step: "wait-for-accounts",
        observed: "no control matched",
      });
      expect(result.kind === "hard-failure" && result.expected).toContain("row");
    } finally {
      await stop();
    }
  });
});
