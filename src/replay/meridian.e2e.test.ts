import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fundsTransferCapability } from "../capability/meridian/funds-transfer.js";
import { memberBalanceCapability } from "../capability/meridian/member-balance.js";
import { memberLookupCapability } from "../capability/meridian/member-lookup.js";
import { openShareCapability } from "../capability/meridian/open-share.js";
import { placeHoldCapability } from "../capability/meridian/place-hold.js";
import { updateMemberCapability } from "../capability/meridian/update-member.js";
import { capabilitiesDir } from "../capability/storage.js";
import { startCatalog, type CatalogServer, type Escalated } from "../catalog/serve.js";
import { logInToMeridian } from "../surface/meridian/login.js";
import { loadSurfaceProfile, surfacesDir, type SurfaceProfile } from "../policy/profile.js";
import { headless } from "../surface/headless.js";
import { PlaywrightSurface } from "../surface/playwright-surface.js";
import { sessionEstablisherFor, type SessionEstablisher } from "../surface/session.js";
import { replayCapability } from "./replay.js";

/**
 * The whole thing against the real MERIDIAN Core, with no model anywhere on the
 * path: the committed Capabilities replayed through a real browser against the
 * live target, the way `replay.e2e.test.ts` does against ParaBank. The scripted
 * `*.test.ts` files prove the Locators address the controls the capture recorded;
 * only this can say MERIDIAN still serves those controls today, that the hidden
 * per-transaction token really rides the native form submit, and that the real
 * 403 really arrives.
 *
 * Three runs, one per acceptance criterion of #30, each an outcome ADR 0004/0005
 * name rather than a screen scraped:
 *
 *   1. Happy path — sign on, look up a member's shares, and post a real transfer
 *      between two of them, returning the confirmation number: a $1 move between
 *      two of the member's own OPEN shares, the smallest demonstrable posted
 *      transfer. This drives the draft `funds-transfer` directly through the
 *      low-level `replayCapability`, which does not gate on approval — the gate is
 *      a boundary concern (`serve.ts`, the CLI), exercised on its own in run 3.
 *      So this proves the recorded flow really posts against the live target; run
 *      3 proves the same draft is refused when reached through the gate.
 *   2. Exceptional state — a teller attempting a hold is turned back by MERIDIAN's
 *      own 403, read as the Business Outcome `SUPERVISOR_OVERRIDE_REQUIRED` (ADR
 *      0008: authorization is the target's to answer). The teller is stopped at
 *      the review step, so nothing is posted — this run writes nothing.
 *   3. Escalation — the policy gate refusing a mutating draft over the catalog
 *      (ADR 0007), surfaced as the `escalated` terminal status with context. The
 *      gate refuses before a run, so this needs neither a browser nor credentials;
 *      it is the pre-run refusal `serve.ts` returns, exercised against the real
 *      committed draft `funds-transfer`.
 *
 * The two live runs need the target reachable and MERIDIAN teller credentials in
 * `.env` (`MERIDIAN_OPERATOR`, `MERIDIAN_PASSWORD`, `MERIDIAN_BRANCH`); a missing
 * one fails loudly rather than skipping, as every e2e here does. The operator must
 * be a plain teller — one who can post a transfer (run 1) but is turned back from a
 * hold (run 2); a supervisor would reach the hold review and run 2 would not see
 * its 403. No key is needed: this is replay, so no model is on the path. The two
 * live runs share the one session `beforeAll` establishes and run in declaration
 * order, which is Vitest's default within a file.
 */
const BASE_URL = (process.env["MERIDIAN_BASE_URL"] ?? "https://web-sample.interface-hiring.com").replace(
  /\/+$/,
  "",
);

/**
 * The captured member — the one every MERIDIAN capture and the recovery e2e use.
 * Its shares are read live rather than assumed, because our own transfers move
 * their balances and OPEN/HOLD statuses are the target's to set.
 */
const CAPTURED_MEMBER = "100234";

/**
 * The smallest transfer that still demonstrates a posted write. Kept tiny on
 * purpose: this posts for real against a shared demo target, so a run leaves the
 * least drift it can.
 */
const TRANSFER_AMOUNT = "1.00";

/**
 * The per-Step wait, set as the Surface default so it governs the whole live flow
 * — sign on, search, walk form → review → post — the way `recoverable.meridian.e2e`
 * sets it on its Surface. Generous enough for a multi-step live flow, short enough
 * that a genuine miss surfaces in seconds rather than minutes.
 */
const TIMEOUT_MS = 20_000;

/** One share as the transfer form's combobox lists it, joined to its live status. */
interface TransferShare {
  /** The exact option label, e.g. `100234-S0001-14 - Regular Shares ($100.00)`. */
  readonly label: string;
  /** The share id parsed from the label, e.g. `100234-S0001-14`. */
  readonly id: string;
  /** The balance parsed from the label, as a number of dollars. */
  readonly balance: number;
  /** The status read off the member record — only OPEN shares can be debited. */
  readonly status: string;
}

describe("replaying the MERIDIAN capabilities against the live target", () => {
  let surface: PlaywrightSurface;
  let profile: SurfaceProfile;
  /** The very adapter `replay` uses to sign on — this test is of that path. */
  let session: SessionEstablisher;

  beforeAll(async () => {
    surface = await PlaywrightSurface.launch({ headless: headless(), defaultTimeoutMs: TIMEOUT_MS });
    profile = await loadSurfaceProfile(surfacesDir(), "meridian");
    // Reads MERIDIAN credentials from `.env` and throws before the run if one is
    // missing — signing on is the caller's job, exactly as it is in the CLI.
    session = sessionEstablisherFor(profile);
    await session.establish(surface, BASE_URL);
  });

  afterAll(async () => {
    await surface.close();
  });

  it("looks up a member and reads the record's values, not its field labels", async () => {
    // The headline bug this proves fixed (ADR 0011): under the old getByRole read
    // lens member-lookup returned "Member No.:"/"Name:" — the labels — because the
    // wrapper row's content-derived name matched the label cell. Resolving through
    // the one perceived tree reads the value cells (ordinals 1 and 3) instead.
    const lookup = await replayCapability(
      surface,
      memberLookupCapability(),
      { by: "Member Number", q: CAPTURED_MEMBER },
      { baseUrl: BASE_URL },
    );
    expect(lookup).toMatchObject({ kind: "success" });
    if (lookup.kind !== "success") return;

    expect(lookup.outputs["memberNumber"]).toBe(CAPTURED_MEMBER);
    const name = lookup.outputs["name"] as string;
    expect(name.trim().length).toBeGreaterThan(0);
    // The regression guard: a value, never the label that sits beside it.
    expect(name).not.toMatch(/^Member No\.?:?$/);
    expect(name).not.toMatch(/^Name:?$/);
  });

  it("reaches NOT_FOUND live when no member matches", async () => {
    // A read-only run whose search click resolves through the perceived tree and
    // whose wait-for-results misses — the miss Replay reads as the NOT_FOUND
    // Business Outcome, not a Hard Failure. Posts nothing.
    const result = await replayCapability(
      surface,
      memberLookupCapability(),
      { by: "Member Number", q: "999999" },
      { baseUrl: BASE_URL, recoverableConditions: profile.recoverableConditions },
    );

    expect(result).toMatchObject({ kind: "business-outcome", name: "NOT_FOUND" });
  });

  it("reaches MULTIPLE_MATCHES live when several members match", async () => {
    // Several matches make the "Select" link ambiguous, so the click misses and
    // the run is left on the results screen — MULTIPLE_MATCHES. This exercises the
    // ambiguity semantics on the acting path now that it resolves through the tree.
    const result = await replayCapability(
      surface,
      memberLookupCapability(),
      { by: "Last Name", q: "o" },
      { baseUrl: BASE_URL, recoverableConditions: profile.recoverableConditions },
    );

    expect(result).toMatchObject({ kind: "business-outcome", name: "MULTIPLE_MATCHES" });
  });

  it("signs on, looks up a member's shares, and posts a real transfer", async () => {
    // Lookup: the read-only leg of the happy path. Its success leaves the Surface
    // on the member record, one click from the transfer form.
    const lookup = await replayCapability(
      surface,
      memberBalanceCapability(),
      { memberNumber: CAPTURED_MEMBER },
      { baseUrl: BASE_URL },
    );
    expect(lookup).toMatchObject({ kind: "success" });
    if (lookup.kind !== "success") return;
    const shares = lookup.outputs["shares"] as ReadonlyArray<Record<string, string>>;
    expect(shares.length).toBeGreaterThan(0);

    // The transfer form lists each share by a label that embeds its live balance
    // ("… ($100.00)"), so the From/To inputs cannot be hard-coded — a balance our
    // own earlier runs moved would no longer match. Read them off the live form.
    const options = await readTransferShares(surface, shares);

    // Debiting a share on HOLD is a Business Outcome, not success, so the source
    // must be OPEN and hold enough for the move. Pick the OPEN share with the most
    // headroom as the source and a different OPEN share as the destination.
    const open = options
      .filter((s) => s.status === "OPEN" && s.balance >= Number(TRANSFER_AMOUNT))
      .sort((a, b) => b.balance - a.balance);
    expect(open.length).toBeGreaterThanOrEqual(2);
    const from = open[0]!;
    const to = open.find((s) => s.id !== from.id)!;

    const result = await replayCapability(
      surface,
      fundsTransferCapability(),
      {
        memberNumber: CAPTURED_MEMBER,
        fromShare: from.label,
        toShare: to.label,
        amount: TRANSFER_AMOUNT,
        memo: "e2e smoke transfer",
      },
      { baseUrl: BASE_URL },
    );

    expect(result).toMatchObject({ kind: "success" });
    if (result.kind !== "success") return;
    // A read of the confirmation cell, so it stays the displayed string — the
    // shape MERIDIAN prints ("CN480242"), not an invented value.
    expect(result.outputs["confirmationNumber"]).toMatch(/^CN\d+$/);
  });

  it("reports a teller's hold attempt as SUPERVISOR_OVERRIDE_REQUIRED", async () => {
    // The share is named the way the hold form lists it — id and type — which the
    // member record already carries, so it is rebuilt from the lookup rather than
    // assumed. Any real share reaches the same review step; the teller is turned
    // back there before anything posts, so this run writes nothing.
    const lookup = await replayCapability(
      surface,
      memberBalanceCapability(),
      { memberNumber: CAPTURED_MEMBER },
      { baseUrl: BASE_URL },
    );
    expect(lookup).toMatchObject({ kind: "success" });
    if (lookup.kind !== "success") return;
    const shares = lookup.outputs["shares"] as ReadonlyArray<Record<string, string>>;
    expect(shares.length).toBeGreaterThan(0);
    const share = shares[0]!;

    const result = await replayCapability(
      surface,
      placeHoldCapability(),
      {
        memberNumber: CAPTURED_MEMBER,
        shareId: `${share["shareId"]} - ${share["type"]}`,
        reasonCode: "FRAUD - Suspected fraud",
        notes: "e2e teller hold attempt",
      },
      { baseUrl: BASE_URL },
    );

    // The 403 named as an outcome the caller acts on, not an error: authorization
    // is MERIDIAN's to answer, and it answered no. Only `name` is asserted, not the
    // step it was caught on: live MERIDIAN prints the "SUPERVISOR OVERRIDE REQUIRED"
    // restricted-function notice on the hold form itself (see the captured
    // `hold.txt`), so the predicate matches as the form loads — a step earlier than
    // the fake script, which models it appearing only after "Continue". The outcome
    // is the same either way; where it is first seen is the target's to decide.
    expect(result).toMatchObject({ kind: "business-outcome", name: "SUPERVISOR_OVERRIDE_REQUIRED" });
  });

  it("opens a share for the member and returns the new share id", async () => {
    // A real posted mutation a teller is allowed to make: the select of the share
    // type, the fill of the deposit, and the Continue/Confirm clicks all resolve
    // through the perceived tree. Success returns the confirmation and the new id.
    const result = await replayCapability(
      surface,
      openShareCapability(),
      {
        memberNumber: CAPTURED_MEMBER,
        shareType: "MMKT - Money Market",
        initialDeposit: "5.00",
      },
      { baseUrl: BASE_URL },
    );

    expect(result).toMatchObject({ kind: "success" });
    if (result.kind !== "success") return;
    expect(result.outputs["confirmationNumber"]).toMatch(/^CN\d+$/);
    expect((result.outputs["newShareId"] as string).length).toBeGreaterThan(0);
  });

  it("updates the member's contact information", async () => {
    // A teller-permitted mutating post over three filled fields. The values are the
    // valid ones the capture recorded, so it posts rather than being turned back as
    // INVALID_EMAIL / INVALID_PHONE.
    const result = await replayCapability(
      surface,
      updateMemberCapability(),
      {
        memberNumber: CAPTURED_MEMBER,
        email: "replay-verify@example.com",
        phone: "555-0155",
        mailingAddress: "9 Verify Lane, Checkstown",
      },
      { baseUrl: BASE_URL },
    );

    expect(result).toMatchObject({ kind: "success" });
  });
});

describe("replaying place-hold against live MERIDIAN as a supervisor", () => {
  let surface: PlaywrightSurface;

  beforeAll(async () => {
    surface = await PlaywrightSurface.launch({ headless: headless(), defaultTimeoutMs: TIMEOUT_MS });
    // A separate session signed on as the supervisor operator, so the same hold a
    // teller is turned back from (SUPERVISOR_OVERRIDE_REQUIRED) posts here — the
    // authorization decision is MERIDIAN's, read from which operator signed on.
    const credentials = {
      operator: requiredEnv("MERIDIAN_SUPERVISOR_OPERATOR"),
      password: requiredEnv("MERIDIAN_SUPERVISOR_PASSWORD"),
      branch: requiredEnv("MERIDIAN_BRANCH"),
    };
    for (const action of logInToMeridian(BASE_URL, credentials)) {
      const result = await surface.perform(action);
      expect(result).toEqual({ kind: "ok" });
    }
  });

  afterAll(async () => {
    await surface.close();
  });

  it("posts the hold a teller is turned back from", async () => {
    // Read the shares live and hold an OPEN one — a share already on HOLD is not a
    // clean subject for a new hold. The share is named the way the hold form lists
    // it: id and type.
    const lookup = await replayCapability(
      surface,
      memberBalanceCapability(),
      { memberNumber: CAPTURED_MEMBER },
      { baseUrl: BASE_URL },
    );
    expect(lookup).toMatchObject({ kind: "success" });
    if (lookup.kind !== "success") return;
    const shares = lookup.outputs["shares"] as ReadonlyArray<Record<string, string>>;
    const open = shares.find((s) => s["status"] === "OPEN");
    expect(open, "the member needs an OPEN share to hold").toBeDefined();

    const result = await replayCapability(
      surface,
      placeHoldCapability(),
      {
        memberNumber: CAPTURED_MEMBER,
        shareId: `${open!["shareId"]} - ${open!["type"]}`,
        reasonCode: "FRAUD - Suspected fraud",
        notes: "e2e supervisor hold",
      },
      { baseUrl: BASE_URL },
    );

    // Authorization is MERIDIAN's to answer (ADR 0008): the supervisor reaches the
    // confirmation the teller never does.
    expect(result).toMatchObject({ kind: "success" });
    if (result.kind !== "success") return;
    expect(result.outputs["confirmationNumber"]).toMatch(/^CN\d+$/);
  });
});

describe("the policy gate escalating a mutating draft over the catalog", () => {
  let catalog: CatalogServer;

  beforeAll(async () => {
    catalog = await startCatalog({
      root: capabilitiesDir(),
      // Never reached: the gate refuses a mutating draft before the runner is
      // called. A throw here would surface as a 500, so a passing test proves the
      // refusal happened first.
      invoke: async () => {
        throw new Error("the runner must not be reached for a refused Capability");
      },
      port: 0,
    });
  });

  afterAll(async () => {
    await catalog.close();
  });

  it("refuses the committed draft funds-transfer with an escalated 403", async () => {
    // `funds-transfer` is committed mutating and draft, so the gate refuses it
    // before any browser exists — the demoable escalation the core produces.
    const response = await fetch(`${catalog.url}/capabilities/funds-transfer/invoke`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        inputs: { memberNumber: CAPTURED_MEMBER, fromShare: "x", toShare: "y", amount: TRANSFER_AMOUNT },
      }),
    });

    expect(response.status).toBe(403);
    const body = (await response.json()) as Escalated;
    expect(body.kind).toBe("escalated");
    expect(body.context.capability).toBe("funds-transfer@1");
    expect(body.context.step).toContain("policy gate");
    expect(body.context.reason).toMatch(/draft/);
  });
});

/**
 * The transfer form's shares as it lists them, joined to the status the member
 * record reports (the form label carries the balance but not the status). Reached
 * from the member record the lookup leaves the Surface on: one click to the form,
 * then the option nodes off the accessibility snapshot.
 */
async function readTransferShares(
  surface: PlaywrightSurface,
  recordShares: ReadonlyArray<Record<string, string>>,
): Promise<TransferShare[]> {
  const opened = await surface.perform({
    kind: "click",
    locator: { role: "link", name: "Funds Transfer", exact: true },
  });
  expect(opened).toEqual({ kind: "ok" });
  const reached = await surface.perform({
    kind: "waitFor",
    locator: { role: "heading", name: "FUNDS TRANSFER", exact: true },
  });
  expect(reached).toEqual({ kind: "ok" });

  const statusById = new Map(recordShares.map((s) => [s["shareId"]!, s["status"]!] as const));

  const seen = new Map<string, TransferShare>();
  for (const node of (await surface.snapshot()).nodes) {
    if (node.role !== "option" || node.name === undefined) continue;
    const parsed = parseTransferOption(node.name);
    if (parsed === undefined || seen.has(parsed.id)) continue;
    seen.set(parsed.id, { ...parsed, status: statusById.get(parsed.id) ?? "" });
  }
  return [...seen.values()];
}

/**
 * `100234-S0001-14 - Regular Shares ($100.00)` → its id and balance. The id is
 * everything before the first " - "; the balance is the parenthesised amount at
 * the end. Anything that is not a share option (a blank, a placeholder) parses to
 * undefined and is skipped.
 */
function parseTransferOption(label: string): { readonly label: string; readonly id: string; readonly balance: number } | undefined {
  const separator = label.indexOf(" - ");
  const balanceMatch = /\(\$([\d,]+\.\d{2})\)\s*$/.exec(label);
  if (separator <= 0 || balanceMatch === null) return undefined;
  return {
    label,
    id: label.slice(0, separator),
    balance: Number(balanceMatch[1]!.replace(/,/g, "")),
  };
}

/** A required environment value, failing loudly before a browser opens if unset. */
function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`${name} is not set. Copy .env.example to .env and fill it in.`);
  }
  return value;
}
