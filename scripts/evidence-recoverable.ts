/**
 * Produce the third error class as committed evidence: a replay that hits a
 * Recoverable Condition — a session that expires mid-run — and absorbs it.
 *
 * The other two classes already have runs under `evidence/runs/`: a Business
 * Outcome (`ACCOUNT_NOT_FOUND`) and a Hard Failure (the injected broken row).
 * This is the one that could only be described, not shown, so this script runs
 * it against a real ParaBank and writes a real evidence trail.
 *
 * The expiry is injected the way `recoverable.e2e.test.ts` injects it: a
 * one-shot interception below the browser replaces the response on the way to
 * the account detail with ParaBank's logged-out page, so everything above —
 * the accessibility tree included — sees exactly what it would on the day a
 * session really lapses. Replay matches the profile's `SESSION_EXPIRED`
 * condition, re-establishes the session, re-runs the Recording, and reaches
 * success. The log shows the sign-in happening twice: once at the start, once
 * mid-run, which is the recovery.
 *
 * Needs ParaBank up (`npm run parabank:start`) and credentials in `.env`.
 * Run with:  npm run evidence:recoverable
 */
import { chromium } from "playwright";
import { accountLookupCapability } from "../src/capability/parabank/account-lookup.js";
import { EvidenceRun, evidenceRunsDir } from "../src/evidence/run.js";
import { EvidenceSurface } from "../src/evidence/evidence-surface.js";
import { mandateFor } from "../src/policy/mandate.js";
import { PolicyGatedSurface } from "../src/policy/policy-gated-surface.js";
import { loadSurfaceProfile, surfacesDir } from "../src/policy/profile.js";
import { coerceTextValues } from "../src/replay/contract-values.js";
import { describeMiss } from "../src/replay/describe.js";
import { replayCapability } from "../src/replay/replay.js";
import { expireSessionOnce } from "../src/surface/parabank/fixtures.js";
import { logInToParabank, type ParabankCredentials } from "../src/surface/parabank/login.js";
import { headless } from "../src/surface/headless.js";
import { PlaywrightSurface } from "../src/surface/playwright-surface.js";
import type { Surface } from "../src/surface/surface.js";

function credentials(): ParabankCredentials {
  const username = process.env["PARABANK_USERNAME"];
  const password = process.env["PARABANK_PASSWORD"];
  if (!username || !password) throw new Error("Set PARABANK_USERNAME and PARABANK_PASSWORD in .env.");
  return { username, password };
}

async function signIn(surface: Surface, baseUrl: string, creds: ParabankCredentials): Promise<void> {
  for (const action of logInToParabank(baseUrl, creds)) {
    const result = await surface.perform(action);
    if (result.kind !== "ok") throw new Error(`Could not sign in to ${baseUrl}: ${describeMiss(result)}`);
  }
}

const capability = accountLookupCapability();
const profile = await loadSurfaceProfile(surfacesDir(), capability.surface);
const baseUrl = (process.env["PARABANK_BASE_URL"] ?? profile.baseUrl).replace(/\/+$/, "");
const creds = credentials();
const mandate = mandateFor(capability);
if (!mandate.allowed) throw new Error(mandate.reason);

const browser = await chromium.launch({ headless: headless() });
const page = await browser.newPage();
// The production stack minus the Controller (there is no escalation here):
// gate over evidence over the real page, so the run is logged and governed the
// same way `replay` logs and governs it.
const evidence = await EvidenceRun.start({
  root: evidenceRunsDir(),
  label: "replay-account-lookup",
  about: { capability: "account-lookup@1", baseUrl, injected: "SESSION_EXPIRED" },
  redaction: { secrets: [creds.password], sensitive: [], masking: "on" },
});
const surface: Surface = new PolicyGatedSurface(
  new EvidenceSurface(new PlaywrightSurface(page, { defaultTimeoutMs: 5_000 }), evidence),
  profile,
  mandate,
);

try {
  await signIn(surface, baseUrl, creds);

  // The account to look up, read off the running application — every fresh
  // container seeds its own numbers.
  const account = (await surface.snapshot()).nodes.find(
    (node) => node.role === "link" && /^\d+$/.test(node.name ?? ""),
  );
  if (account?.name === undefined) throw new Error("No account link on the overview to look up.");
  const inputs = coerceTextValues(capability.contract.inputs, { accountId: account.name }, "Recoverable demo");

  // The one-shot expiry on the way to the account detail.
  const stop = await expireSessionOnce(page, { baseUrl, path: "/activity.htm" });
  let reEstablished = 0;
  try {
    const result = await replayCapability(surface, capability, inputs, {
      baseUrl,
      recoverableConditions: profile.recoverableConditions,
      reestablishSession: async () => {
        reEstablished += 1;
        await signIn(surface, baseUrl, creds);
      },
    });

    if (result.kind !== "success") throw new Error(`Expected success after recovery, got ${result.kind}.`);
    if (reEstablished !== 1) throw new Error(`Expected exactly one recovery, saw ${reEstablished}.`);
    await evidence.finish("success", { recovered: "SESSION_EXPIRED" });
    console.log(`Recovered a SESSION_EXPIRED mid-replay and reached success for account ${account.name}.`);
    console.log(`Evidence: ${evidence.directory}`);
  } finally {
    await stop();
  }
} catch (error) {
  await evidence.finish("hard-failure", {
    observed: error instanceof Error ? error.message : String(error),
  });
  throw error;
} finally {
  await browser.close();
}

export {};
