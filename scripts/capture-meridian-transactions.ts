/**
 * Captures the MERIDIAN Core transfer and hold screens the `funds-transfer` and
 * `place-hold` Capabilities (#24) are recorded against — the review, posted, and
 * validation-rejection screens that the committed `transfer.txt` / `hold.txt`
 * form captures do not reach.
 *
 * It exists for the same reason `capture-meridian-members` did: those screens
 * were never captured, and a Capability cannot be recorded honestly without
 * them. The fake Surface answers from real captures on purpose (see
 * `src/surface/meridian/fake-script.ts`); a hand-written review or confirmation
 * tree would quietly describe the application we wish we had.
 *
 * The screens fall in two classes:
 *
 *   - **Non-mutating** (the default run): the transfer review ("CONFIRM FUNDS
 *     TRANSFER"), the two transfer rejections a bad request is turned back with
 *     ("Source share is HOLD…" and "Insufficient available balance…"), and the
 *     hold supervisor-override screen a teller is stopped at. All four are
 *     reached by clicking "Continue" and reading the screen it leads to; none
 *     posts anything.
 *   - **Mutating** (explicit requests only): `transfer-post` clicks "Post
 *     Transfer" and moves $1 between two of the member's own shares to reach the
 *     "TRANSFER POSTED" confirmation; `hold-post` places a hold and needs a
 *     SUPERVISOR sign-on (a teller only ever reaches the 403). These change data
 *     and are never part of a default run.
 *
 * Per ADR 0001 the Capabilities target only by role and accessible name, but a
 * capture tool is raw Playwright and not bound by that: it selects shares by
 * their stable option **value** (the share id) rather than the balance-bearing
 * label, so a run does not break when a balance moves. Every captured tree is
 * run through `redactSessionIds` (ADR 0006) so no live `SID` reaches a fixture.
 *
 * Each capture verifies the screen it landed on carries its expected marker and
 * fails loudly otherwise, so a share whose HOLD state has since changed produces
 * an error rather than a mislabelled fixture.
 *
 * Run with: npm run capture:meridian-txn                # the four non-mutating screens
 *           npm run capture:meridian-txn -- transfer-post   # + the posted confirmation (moves $1)
 *           npm run capture:meridian-txn -- hold-post       # the hold confirmation (needs supervisor)
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium, type Page } from "playwright";
import { readAriaSnapshot, reportAddressability } from "../src/surface/aria-snapshot.js";
import { redactSessionIds } from "../src/evidence/redact-session-ids.js";
import { MERIDIAN_SIGN_ON_PATH } from "../src/surface/meridian/login.js";

const BASE_URL = (process.env["MERIDIAN_BASE_URL"] ?? "https://web-sample.interface-hiring.com").replace(
  /\/+$/,
  "",
);
const OPERATOR = required("MERIDIAN_OPERATOR");
const PASSWORD = required("MERIDIAN_PASSWORD");
const BRANCH = required("MERIDIAN_BRANCH");

/** The member the transfer/hold captures are taken against — the same one the
 * form and record captures already committed use. */
const MEMBER = process.env["MERIDIAN_TXN_MEMBER"] ?? "100234";

/**
 * Which share ids the captures drive the forms with. Chosen from the committed
 * `member-100234` record: `FROM_OPEN` and `TO_OPEN` are OPEN shares (debitable),
 * `FROM_HELD` is a share on HOLD (so a debit from it is refused). Overridable by
 * env because a demo installation's HOLD states drift over time.
 */
const FROM_OPEN = process.env["MERIDIAN_TXN_FROM_OPEN"] ?? "100234-S0001-26";
const TO_OPEN = process.env["MERIDIAN_TXN_TO_OPEN"] ?? "100234-S0001-25";
const FROM_HELD = process.env["MERIDIAN_TXN_FROM_HELD"] ?? "100234-S0001";
const HOLD_SHARE = process.env["MERIDIAN_TXN_HOLD_SHARE"] ?? "100234-S0001";
/** A reason picked by its exact option label — the value the Capability's enum uses. */
const HOLD_REASON_LABEL = process.env["MERIDIAN_TXN_HOLD_REASON"] ?? "FRAUD - Suspected fraud";

const OUTPUT_DIR = join(process.cwd(), "evidence", "accessibility-tree", "meridian");

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`${name} is not set. Copy .env.example to .env and fill it in.`);
  }
  return value;
}

async function main(): Promise<void> {
  const requests = process.argv.slice(2);
  const unknown = requests.filter((r) => !KNOWN.has(r));
  if (unknown.length > 0) {
    throw new Error(`Unrecognised request(s): ${unknown.join(", ")}. Known: ${[...KNOWN].join(", ")}.`);
  }

  await mkdir(OUTPUT_DIR, { recursive: true });
  const browser = await chromium.launch();
  try {
    // hold-post needs a supervisor session; everything else runs as the teller.
    const wantsHoldPost = requests.includes("hold-post");
    const tellerRequests = requests.length === 0 ? DEFAULT_REQUESTS : requests.filter((r) => r !== "hold-post");

    if (tellerRequests.length > 0) {
      const page = await browser.newPage();
      await signOn(page, OPERATOR, PASSWORD);
      await runTellerRequests(page, tellerRequests);
    }
    if (wantsHoldPost) {
      const supOperator = required("MERIDIAN_SUPERVISOR_OPERATOR");
      const supPassword = required("MERIDIAN_SUPERVISOR_PASSWORD");
      const supPage = await browser.newPage();
      await signOn(supPage, supOperator, supPassword);
      await captureHoldPost(supPage);
    }
  } finally {
    await browser.close();
  }
}

const DEFAULT_REQUESTS = [
  "transfer-review",
  "transfer-source-on-hold",
  "transfer-insufficient",
  "hold-override",
];
const KNOWN = new Set([...DEFAULT_REQUESTS, "transfer-post", "hold-post"]);

async function runTellerRequests(page: Page, requests: string[]): Promise<void> {
  for (const request of requests) {
    switch (request) {
      case "transfer-review":
        await captureTransferReview(page);
        break;
      case "transfer-source-on-hold":
        await captureTransferReject(page, FROM_HELD, "transfer-source-on-hold", "Source share is HOLD");
        break;
      case "transfer-insufficient":
        await captureTransferReject(
          page,
          FROM_OPEN,
          "transfer-insufficient-funds",
          "Insufficient available balance",
          "999999.00",
        );
        break;
      case "hold-override":
        await captureHoldOverride(page);
        break;
      case "transfer-post":
        await captureTransferPost(page);
        break;
      // "hold-post" is filtered out before here — it runs on a supervisor
      // session in main(), not this teller one.
    }
  }
}

/** Fills the transfer form (shares by value, amount/memo by role) and clicks Continue. */
async function fillTransfer(page: Page, from: string, to: string, amount: string, memo: string): Promise<void> {
  await page.goto(`${BASE_URL}/members/${MEMBER}/transfer`);
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.getByRole("combobox").nth(0).selectOption(from);
  await page.getByRole("combobox").nth(1).selectOption(to);
  const boxes = page.getByRole("textbox");
  await boxes.nth(0).fill(amount);
  await boxes.nth(1).fill(memo);
  await page.getByRole("button", { name: "Continue" }).click();
  await page.waitForLoadState("networkidle").catch(() => {});
}

async function captureTransferReview(page: Page): Promise<void> {
  await fillTransfer(page, FROM_OPEN, TO_OPEN, "1.00", "capture probe");
  await expectText(page, "CONFIRM FUNDS TRANSFER", "transfer-review");
  await captureCurrent(page, "transfer-review");
}

async function captureTransferReject(
  page: Page,
  from: string,
  slug: string,
  marker: string,
  amount = "1.00",
): Promise<void> {
  await fillTransfer(page, from, TO_OPEN, amount, "");
  await expectText(page, marker, slug);
  await captureCurrent(page, slug);
}

/** MUTATES: posts a $1 transfer between the member's own shares. */
async function captureTransferPost(page: Page): Promise<void> {
  await fillTransfer(page, FROM_OPEN, TO_OPEN, "1.00", "capture probe");
  await expectText(page, "CONFIRM FUNDS TRANSFER", "transfer-review(pre-post)");
  await page.getByRole("button", { name: "Post Transfer" }).click();
  await page.waitForLoadState("networkidle").catch(() => {});
  await expectText(page, "TRANSFER POSTED", "transfer-complete");
  await captureCurrent(page, "transfer-complete");
}

/** Fills the hold form (share/reason by label, notes by role) and clicks Continue. */
async function fillHold(page: Page): Promise<void> {
  await page.goto(`${BASE_URL}/members/${MEMBER}/hold`);
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.getByRole("combobox").nth(0).selectOption(HOLD_SHARE);
  await page.getByRole("combobox").nth(1).selectOption({ label: HOLD_REASON_LABEL });
  await page.getByRole("button", { name: "Continue" }).click();
  await page.waitForLoadState("networkidle").catch(() => {});
}

/** Teller path: the hold is a RESTRICTED FUNCTION, so Continue reaches the 403. */
async function captureHoldOverride(page: Page): Promise<void> {
  await fillHold(page);
  await expectText(page, "SUPERVISOR OVERRIDE REQUIRED", "hold-override-required");
  await captureCurrent(page, "hold-override-required");
}

/**
 * MUTATES + supervisor: a supervisor's "Continue" reaches the "CONFIRM ACCOUNT
 * HOLD" review (a teller's reaches the 403 instead), and "Apply Hold" posts it.
 * Captures both the review and the posted confirmation.
 */
async function captureHoldPost(page: Page): Promise<void> {
  await fillHold(page);
  await expectText(page, "CONFIRM ACCOUNT HOLD", "hold-review");
  await captureCurrent(page, "hold-review");
  await page.getByRole("button", { name: "Apply Hold" }).click();
  await page.waitForLoadState("networkidle").catch(() => {});
  await captureCurrent(page, "hold-complete");
}

/** Snapshots the page as it now stands and writes it as a committed fixture. */
async function captureCurrent(page: Page, slug: string): Promise<void> {
  await page.waitForLoadState("networkidle").catch(() => {});
  const tree = redactSessionIds(await page.ariaSnapshot());
  const report = reportAddressability(readAriaSnapshot(tree));
  const file = join(OUTPUT_DIR, `${slug}.txt`);
  await writeFile(file, `URL: ${redactSessionIds(page.url())}\n\n${tree}\n`, "utf8");
  console.log(
    `${slug}: ${report.addressable.length} addressable, ` +
      `${report.unaddressable.length} unnamed, ${report.ambiguous.length} ambiguous -> ${file}`,
  );
}

/** Fails loudly if the screen just reached does not carry the marker we expect. */
async function expectText(page: Page, marker: string, slug: string): Promise<void> {
  const tree = await page.ariaSnapshot();
  if (!tree.includes(marker)) {
    throw new Error(
      `Capture "${slug}" expected the screen to carry "${marker}", but it did not. ` +
        `The share state may have drifted — override MERIDIAN_TXN_* and retry. URL: ${page.url()}`,
    );
  }
}

async function signOn(page: Page, operator: string, password: string): Promise<void> {
  await page.goto(`${BASE_URL}${MERIDIAN_SIGN_ON_PATH}`);
  const textboxes = page.getByRole("textbox");
  await textboxes.nth(0).fill(operator);
  await textboxes.nth(1).fill(password);
  await page.getByRole("combobox").first().selectOption({ label: BRANCH });
  await page.getByRole("button", { name: "Sign On" }).click();
  await page.getByRole("heading", { name: "MAIN MENU" }).waitFor();
}

await main();
