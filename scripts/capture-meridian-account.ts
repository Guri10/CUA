/**
 * Captures the MERIDIAN Core open-share and update-member screens the
 * `open-share` and `update-member` Capabilities (#25) are recorded against — the
 * two forms, the open-share review, the posted / saved confirmations, and the
 * validation-rejection screens that a form capture alone does not reach.
 *
 * It exists for the same reason `capture-meridian-transactions` did: those
 * screens were never captured, and a Capability cannot be recorded honestly
 * without them. The fake Surface answers from real captures on purpose (see
 * `src/surface/meridian/fake-script.ts`); a hand-written review or confirmation
 * tree would quietly describe the application we wish we had.
 *
 * The screens fall in two classes:
 *
 *   - **Non-mutating** (the default run): the open-share form, its "CONFIRM NEW
 *     SHARE" review, and its minimum-deposit rejection; the update form and its
 *     two validation rejections (invalid e-mail, invalid phone). None of these
 *     posts anything — a review is pre-post and a rejection is refused.
 *   - **Mutating** (explicit requests only): `open-share-post` opens a real new
 *     share and reaches "SHARE OPENED"; `update-save` re-saves the member's
 *     current contact values and reaches "MEMBER INFORMATION UPDATED". These
 *     change data and are never part of a default run.
 *
 * Per ADR 0001 the Capabilities target only by role and accessible name; this
 * capture tool is raw Playwright and not bound by that, but it happens to select
 * the share type by the option's exact label — the same string the Capability's
 * enum uses. Every captured tree is run through `redactSessionIds` (ADR 0006) so
 * no live `SID` reaches a fixture.
 *
 * Each capture verifies the screen it landed on carries its expected marker and
 * fails loudly otherwise, so a drifted form produces an error rather than a
 * mislabelled fixture.
 *
 * Run with: npm run capture:meridian-account                 # the six non-mutating screens
 *           npm run capture:meridian-account -- open-share-post  # + SHARE OPENED (opens a real share)
 *           npm run capture:meridian-account -- update-save      # + MEMBER INFORMATION UPDATED (saves)
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

/** The member the account captures are taken against — the same one the record,
 * transfer, and hold captures already committed use. */
const MEMBER = process.env["MERIDIAN_TXN_MEMBER"] ?? "100234";

/**
 * The share type the open-share captures drive the form with, by its exact
 * option label — the first type the form lists. Overridable by env.
 */
const SHARE_TYPE = process.env["MERIDIAN_OPEN_SHARE_TYPE"] ?? "S0001 - Regular Shares";
/** A deposit at or over MERIDIAN's $5.00 minimum — the review and post need one. */
const VALID_DEPOSIT = process.env["MERIDIAN_OPEN_SHARE_DEPOSIT"] ?? "5.00";
/** A deposit under the minimum, to reach the minimum-deposit rejection. */
const LOW_DEPOSIT = process.env["MERIDIAN_OPEN_SHARE_LOW_DEPOSIT"] ?? "1.00";

/**
 * The member's contact values `update-save` re-saves. These are the values the
 * update form already holds on the demo installation (a prior verify run), so
 * saving them again is idempotent. Overridable by env.
 */
const SAVE_EMAIL = process.env["MERIDIAN_UPDATE_EMAIL"] ?? "replay-verify@example.com";
const SAVE_PHONE = process.env["MERIDIAN_UPDATE_PHONE"] ?? "555-0155";
const SAVE_ADDRESS = process.env["MERIDIAN_UPDATE_ADDRESS"] ?? "9 Verify Lane, Checkstown";

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
  const toRun = requests.length === 0 ? DEFAULT_REQUESTS : requests;

  await mkdir(OUTPUT_DIR, { recursive: true });
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await signOn(page, OPERATOR, PASSWORD);
    for (const request of toRun) {
      await run(page, request);
    }
  } finally {
    await browser.close();
  }
}

const DEFAULT_REQUESTS = [
  "open-share-form",
  "open-share-review",
  "open-share-min-deposit",
  "update-form",
  "update-invalid-email",
  "update-invalid-phone",
];
const KNOWN = new Set([...DEFAULT_REQUESTS, "open-share-post", "update-save"]);

async function run(page: Page, request: string): Promise<void> {
  switch (request) {
    case "open-share-form":
      await captureOpenShareForm(page);
      break;
    case "open-share-review":
      await captureOpenShareReview(page);
      break;
    case "open-share-min-deposit":
      await captureOpenShareMinDeposit(page);
      break;
    case "open-share-post":
      await captureOpenSharePost(page);
      break;
    case "update-form":
      await captureUpdateForm(page);
      break;
    case "update-invalid-email":
      await captureUpdateInvalidEmail(page);
      break;
    case "update-invalid-phone":
      await captureUpdateInvalidPhone(page);
      break;
    case "update-save":
      await captureUpdateSave(page);
      break;
  }
}

/** Loads the open-share form and selects the share type; leaves the deposit to the caller. */
async function openShareForm(page: Page): Promise<void> {
  await page.goto(`${BASE_URL}/members/${MEMBER}/open-share`);
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.getByRole("combobox").nth(0).selectOption(SHARE_TYPE);
}

async function captureOpenShareForm(page: Page): Promise<void> {
  await openShareForm(page);
  await expectText(page, "OPEN NEW SHARE", "open-share");
  await captureCurrent(page, "open-share");
}

async function captureOpenShareReview(page: Page): Promise<void> {
  await openShareForm(page);
  await page.getByRole("textbox").nth(0).fill(VALID_DEPOSIT);
  await page.getByRole("button", { name: "Continue" }).click();
  await expectText(page, "CONFIRM NEW SHARE", "open-share-review");
  await captureCurrent(page, "open-share-review");
}

/** A deposit under the minimum: Continue reaches the rejection, not the review. */
async function captureOpenShareMinDeposit(page: Page): Promise<void> {
  await openShareForm(page);
  await page.getByRole("textbox").nth(0).fill(LOW_DEPOSIT);
  await page.getByRole("button", { name: "Continue" }).click();
  await expectText(page, "A minimum opening deposit", "open-share-min-deposit");
  await captureCurrent(page, "open-share-min-deposit");
}

/** MUTATES: opens a real new share, reaching the "SHARE OPENED" confirmation. */
async function captureOpenSharePost(page: Page): Promise<void> {
  await openShareForm(page);
  await page.getByRole("textbox").nth(0).fill(VALID_DEPOSIT);
  await page.getByRole("button", { name: "Continue" }).click();
  await expectText(page, "CONFIRM NEW SHARE", "open-share-review(pre-post)");
  await page.getByRole("button", { name: "Open Share" }).click();
  await expectText(page, "SHARE OPENED", "open-share-complete");
  await captureCurrent(page, "open-share-complete");
}

async function captureUpdateForm(page: Page): Promise<void> {
  await page.goto(`${BASE_URL}/members/${MEMBER}/update`);
  await expectText(page, "UPDATE MEMBER INFORMATION", "update");
  await captureCurrent(page, "update");
}

/** An e-mail with no valid format: Save Changes is refused, nothing is saved. */
async function captureUpdateInvalidEmail(page: Page): Promise<void> {
  await page.goto(`${BASE_URL}/members/${MEMBER}/update`);
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.getByRole("textbox").nth(0).fill("not-an-email");
  await page.getByRole("button", { name: "Save Changes" }).click();
  await expectText(page, "E-mail address is not in a valid format.", "update-invalid-email");
  await captureCurrent(page, "update-invalid-email");
}

/** A valid e-mail but an invalid phone: the other refusal Save Changes serves. */
async function captureUpdateInvalidPhone(page: Page): Promise<void> {
  await page.goto(`${BASE_URL}/members/${MEMBER}/update`);
  await page.waitForLoadState("networkidle").catch(() => {});
  const boxes = page.getByRole("textbox");
  await boxes.nth(0).fill(SAVE_EMAIL);
  await boxes.nth(1).fill("not-a-phone!!");
  await page.getByRole("button", { name: "Save Changes" }).click();
  await expectText(page, "Phone number is not valid.", "update-invalid-phone");
  await captureCurrent(page, "update-invalid-phone");
}

/** MUTATES: re-saves the member's current contact values, reaching the confirmation. */
async function captureUpdateSave(page: Page): Promise<void> {
  await page.goto(`${BASE_URL}/members/${MEMBER}/update`);
  await page.waitForLoadState("networkidle").catch(() => {});
  const boxes = page.getByRole("textbox");
  await boxes.nth(0).fill(SAVE_EMAIL);
  await boxes.nth(1).fill(SAVE_PHONE);
  await boxes.nth(2).fill(SAVE_ADDRESS);
  await page.getByRole("button", { name: "Save Changes" }).click();
  await expectText(page, "MEMBER INFORMATION UPDATED", "update-complete");
  await captureCurrent(page, "update-complete");
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
      `Capture "${slug}" expected the screen to carry "${marker}", but it did not. URL: ${page.url()}`,
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
