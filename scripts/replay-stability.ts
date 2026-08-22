/**
 * Multi-run stability: replay the read-only lookup many times over one signed-in
 * session and report how much its answer varied.
 *
 * Replay is meant to be deterministic — same inputs, same Steps, same outputs,
 * no model in the loop — so the number this prints should be zero: every run
 * returns the same account type and balance. It is the read-only Capability, so
 * running it twenty times changes nothing on the bank; the point is to measure
 * the claim rather than assert it.
 *
 * It drives the production `replayCapability` on one gated, logged Surface, so
 * what it measures is the real path and not a re-implementation of it. Evidence
 * is written to a throwaway temp directory rather than `evidence/runs/`, so a
 * stability sweep does not litter the committed trail with twenty directories.
 *
 * Run with:  npm run replay:stability  [-- --runs 20 --input accountId=12345]
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCapabilityRef, capabilitiesDir } from "../src/capability/storage.js";
import { EvidenceRun } from "../src/evidence/run.js";
import { mandateFor } from "../src/policy/mandate.js";
import { openBrowserSurface } from "../src/policy/open-surface.js";
import { loadSurfaceProfile, surfacesDir } from "../src/policy/profile.js";
import { coerceTextValues } from "../src/replay/contract-values.js";
import { describeMiss } from "../src/replay/describe.js";
import { replayCapability } from "../src/replay/replay.js";
import { logInToParabank, type ParabankCredentials } from "../src/surface/parabank/login.js";
import type { Surface } from "../src/surface/surface.js";

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 1) {
  const token = process.argv[i]!;
  if (token.startsWith("--")) args.set(token.slice(2), process.argv[++i] ?? "");
}

const runsArg = args.get("runs") ?? "20";
const runs = Number(runsArg);
if (!Number.isInteger(runs) || runs < 1) {
  throw new Error(`--runs takes a whole number of at least 1, not "${runsArg}".`);
}

// Split at the first `=` so a value may contain one, and refuse a key other than
// the one the lookup declares rather than silently binding it — the way the CLI
// refuses an undeclared input.
const inputArg = args.get("input") ?? "accountId=12345";
const eq = inputArg.indexOf("=");
const accountId = eq === -1 ? "" : inputArg.slice(eq + 1);
if (inputArg.slice(0, eq) !== "accountId" || accountId === "") {
  throw new Error(`--input takes accountId=<value>, not "${inputArg}".`);
}

function credentials(): ParabankCredentials {
  const username = process.env["PARABANK_USERNAME"];
  const password = process.env["PARABANK_PASSWORD"];
  if (!username || !password) throw new Error("Set PARABANK_USERNAME and PARABANK_PASSWORD in .env.");
  return { username, password };
}

// The same login loop the CLI's `establishSession` runs, over the shared
// `logInToParabank` sequence, with the same miss detail on failure. It is a few
// lines of glue rather than shared code because the CLI defines it in a module
// that runs a command on import.
async function signIn(surface: Surface, baseUrl: string, creds: ParabankCredentials): Promise<void> {
  for (const action of logInToParabank(baseUrl, creds)) {
    const result = await surface.perform(action);
    if (result.kind !== "ok") throw new Error(`Could not sign in to ${baseUrl}: ${describeMiss(result)}`);
  }
}

const capability = await loadCapabilityRef(capabilitiesDir(), "account-lookup@1");
const profile = await loadSurfaceProfile(surfacesDir(), capability.surface);
const baseUrl = (process.env["PARABANK_BASE_URL"] ?? profile.baseUrl).replace(/\/+$/, "");
const creds = credentials();
const inputs = coerceTextValues(capability.contract.inputs, { accountId }, "Stability input");

const root = await mkdtemp(join(tmpdir(), "cua-stability-"));
const evidence = await EvidenceRun.start({
  root,
  label: "stability",
  about: { capability: "account-lookup@1", runs: String(runs) },
  redaction: { secrets: [creds.password], sensitive: [accountId], masking: "on" },
});
const mandate = mandateFor(capability);
// The lookup is read-only, so this always holds; checked rather than asserted
// so the script fails with a sentence if it is ever pointed at a mutating one.
if (!mandate.allowed) throw new Error(mandate.reason);
const { surface, close } = await openBrowserSurface(profile, mandate, evidence, { headless: true });

const seen = new Map<string, number>();
try {
  await signIn(surface, baseUrl, creds);
  for (let run = 1; run <= runs; run += 1) {
    const result = await replayCapability(surface, capability, inputs, {
      baseUrl,
      // The same interruption handling the production replay wires in, so a
      // session that expires mid-sweep is re-established and absorbed rather
      // than failing the run — the script measures the real path, not a
      // stripped-down one.
      recoverableConditions: profile.recoverableConditions,
      reestablishSession: () => signIn(surface, baseUrl, creds),
    });
    if (result.kind !== "success") throw new Error(`Run ${run} did not succeed: ${result.kind}.`);
    const answer = JSON.stringify(result.outputs);
    seen.set(answer, (seen.get(answer) ?? 0) + 1);
  }
} finally {
  await close();
  await rm(root, { recursive: true, force: true });
}

// The figure: how many distinct answers the same request produced. One means
// perfectly stable; the "variance" the report cites is `distinct - 1`.
const distinct = seen.size;
const variance = distinct - 1;
console.log(`Replayed account-lookup@1 (accountId=${accountId}) ${runs} times.`);
console.log(`Distinct results: ${distinct}  (variance = ${variance})`);
for (const [answer, count] of seen) console.log(`  ${count}/${runs}  ${answer}`);
process.exitCode = variance === 0 ? 0 : 1;

export {};
