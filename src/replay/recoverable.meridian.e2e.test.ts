import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { memberBalanceCapability } from "../capability/meridian/member-balance.js";
import { loadSurfaceProfile, surfacesDir, type SurfaceProfile } from "../policy/profile.js";
import { headless } from "../surface/headless.js";
import { PlaywrightSurface } from "../surface/playwright-surface.js";
import { sessionEstablisherFor, type SessionEstablisher } from "../surface/session.js";
import { replayCapability } from "./replay.js";

/**
 * The recoverable path, against the running MERIDIAN Core.
 *
 * `recoverable.meridian.test.ts` runs the same logic against a scripted fake and
 * proves it; only this can say what MERIDIAN actually does when a session lapses
 * mid-run, and that the CLI's own sign-on adapter re-establishes it. The whole
 * production path is exercised: `sessionEstablisherFor` signs in and signs back
 * in from `.env`, exactly as `replay` does, and Replay matches the profile's real
 * `SESSION_EXPIRED` condition against the real 440 screen.
 *
 * The timeout is injected the way `recoverable.e2e.test.ts` injects ParaBank's:
 * one request on the way to the member record is sent through MERIDIAN's own
 * `?inject=timeout` fault hook, so the server serves its real "Session Ended"
 * page and ends the session — everything above, the accessibility tree included,
 * sees exactly what it would on the day a session really lapses. The hook is used
 * only to test, never wired into the system.
 *
 * Needs the live target reachable and MERIDIAN credentials in `.env`.
 */
const BASE_URL = (process.env["MERIDIAN_BASE_URL"] ?? "https://web-sample.interface-hiring.com").replace(
  /\/+$/,
  "",
);
const CAPTURED_MEMBER = "100234";

/**
 * Shorter than the Surface's default: the run signs in, hits the interstitial,
 * signs in again, and re-runs, so a generous per-Step wait would make a failure
 * take minutes to surface.
 */
const TIMEOUT_MS = 15_000;

describe("a real MERIDIAN session that times out mid-replay", () => {
  let browser: Browser;
  /** Held directly, because interception is a property of the page below the Surface. */
  let page: Page;
  let surface: PlaywrightSurface;
  let profile: SurfaceProfile;
  /** The very adapter `replay` uses — this test is of that path, not a parallel one. */
  let session: SessionEstablisher;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: headless() });
    page = await browser.newPage();
    surface = new PlaywrightSurface(page, { defaultTimeoutMs: TIMEOUT_MS });
    profile = await loadSurfaceProfile(surfacesDir(), "meridian");
    session = sessionEstablisherFor(profile);
    await session.establish(surface, BASE_URL);
  });

  afterAll(async () => {
    await browser.close();
  });

  it("re-establishes the timed-out session and returns the member's shares", async () => {
    // Trip the real 440 once, on the way to the record: fetch that one request
    // through the fault hook and serve its response back. Run in the browser's
    // own context, so the request carries the live session and the server both
    // returns the real "Session Ended" screen and ends the session.
    let injected = 0;
    await page.route(
      (url) => new URL(url).pathname.endsWith(`/members/${CAPTURED_MEMBER}`),
      async (route) => {
        injected += 1;
        const response = await route.fetch({ url: `${route.request().url()}?inject=timeout` });
        await route.fulfill({ response });
      },
      { times: 1 },
    );

    let reEstablished = 0;
    const result = await replayCapability(
      surface,
      memberBalanceCapability(),
      { memberNumber: CAPTURED_MEMBER },
      {
        baseUrl: BASE_URL,
        recoverableConditions: profile.recoverableConditions,
        reestablishSession: async () => {
          reEstablished += 1;
          await session.establish(surface, BASE_URL);
        },
      },
    );

    // The fault really fired, and the run really recovered — without both, a
    // plain success would prove nothing about recovery.
    expect(injected).toBe(1);
    expect(reEstablished).toBe(1);

    expect(result.kind).toBe("success");
    expect(result.kind === "success" && (result.outputs["shares"] as unknown[]).length).toBeGreaterThan(0);
  });
});
