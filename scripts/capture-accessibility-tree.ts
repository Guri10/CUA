/**
 * Captures the accessibility tree of ParaBank's login, accounts overview, and
 * account detail pages, and reports which controls on each are addressable by
 * role and accessible name.
 *
 * This exists to answer one question before anything is built on top of it: is
 * ParaBank's accessibility tree rich enough to be the targeting contract ADR
 * 0001 makes it? The output under `evidence/accessibility-tree/` is the answer.
 *
 * Per ADR 0001 this script targets only by role, accessible name, and ordinal.
 * No CSS or XPath appears here — not even in the login step, where ParaBank
 * gives its inputs no accessible name at all, and not in taking the snapshot.
 *
 * Run with: npm run capture:a11y
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium, type Page } from "playwright";
import {
  readAriaSnapshot,
  reportAddressability,
  type AddressabilityReport,
  type AriaNode,
} from "../src/surface/aria-snapshot.js";
import { redactSessionIds } from "../src/evidence/redact-session-ids.js";

const BASE_URL = process.env["PARABANK_BASE_URL"] ?? "http://localhost:8080/parabank";
const USERNAME = required("PARABANK_USERNAME");
const PASSWORD = required("PARABANK_PASSWORD");

/**
 * ADR 0006 classes the application password a Secret — never written anywhere,
 * with no flag to turn that off — so it has no default here and no literal in
 * any tracked file. Copy `.env.example` to `.env` and fill it in; README names
 * the credentials the container seeds.
 */
function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`${name} is not set. Copy .env.example to .env and fill it in.`);
  }
  return value;
}

const OUTPUT_DIR = join(process.cwd(), "evidence", "accessibility-tree");

interface CapturedScreen {
  readonly slug: string;
  readonly title: string;
  readonly url: string;
  readonly snapshot: string;
}

interface ReviewedScreen extends CapturedScreen {
  readonly report: AddressabilityReport;
}

async function main(): Promise<void> {
  await mkdir(OUTPUT_DIR, { recursive: true });

  const browser = await chromium.launch();
  const captured: CapturedScreen[] = [];

  try {
    const page = await browser.newPage();

    await page.goto(`${BASE_URL}/index.htm`);
    captured.push(await capture(page, "01-login", "Customer Login"));

    await logIn(page);
    captured.push(await capture(page, "02-accounts-overview", "Accounts Overview"));

    await openFirstAccount(page);
    captured.push(await capture(page, "03-account-detail", "Account Details"));
  } finally {
    await browser.close();
  }

  const reviewed = captured.map((item) => ({
    ...item,
    report: reportAddressability(readAriaSnapshot(item.snapshot)),
  }));

  for (const item of reviewed) {
    await writeFile(join(OUTPUT_DIR, `${item.slug}.aria.yaml`), item.snapshot, "utf8");
  }

  await writeFile(
    join(OUTPUT_DIR, "addressability.json"),
    `${JSON.stringify(summarize(reviewed), null, 2)}\n`,
    "utf8",
  );

  for (const { slug, report } of reviewed) {
    console.log(
      `${slug}: ${report.addressable.length} addressable, ` +
        `${report.unaddressable.length} unnamed, ${report.ambiguous.length} ambiguous`,
    );
  }
  console.log(`\nWrote ${reviewed.length} snapshots to ${OUTPUT_DIR}`);
}

/**
 * ParaBank's login inputs carry no accessible name — see `01-login.aria.yaml`,
 * where they appear as bare `- textbox` with the words "Username" and
 * "Password" in sibling paragraphs rather than in labels. Ordinal within the
 * page's textboxes is the only accessibility-vocabulary handle available, and
 * ADR 0001 permits exactly that. It is not a preference; it is what this
 * application leaves us.
 */
async function logIn(page: Page): Promise<void> {
  const textboxes = page.getByRole("textbox");
  await textboxes.nth(0).fill(USERNAME);
  await textboxes.nth(1).fill(PASSWORD);
  await page.getByRole("button", { name: "Log In" }).click();
  await page.getByRole("heading", { name: "Accounts Overview" }).waitFor();

  // The overview table fills from a later request, exactly as the detail table
  // does. Waiting only for the heading captures the page with its account rows
  // still missing — which is what the first run of this script recorded. Wait
  // for a row whose accessible name carries an amount.
  await page.getByRole("row", { name: /\$/ }).first().waitFor();
}

/**
 * Each account number on the overview is a link whose accessible name is the
 * account number itself, so the detail page is reached by role and name. The
 * number is read from the tree rather than hardcoded, because ParaBank seeds a
 * different set on every fresh container.
 */
async function openFirstAccount(page: Page): Promise<void> {
  const accountLink = page.getByRole("cell").getByRole("link").first();
  const accountNumber = (await accountLink.textContent())?.trim();
  if (accountNumber === undefined || accountNumber === "") {
    throw new Error("No account link found on the Accounts Overview page.");
  }

  await page.getByRole("link", { name: accountNumber, exact: true }).first().click();
  await page.getByRole("heading", { name: "Account Details" }).waitFor();

  // The detail table renders its labels immediately and fills the value cells
  // from a later request, so a snapshot taken on page load catches "Balance:"
  // next to an empty cell. Waiting for the row's accessible name to carry a
  // value is the accessibility-vocabulary way to know the read is safe — and it
  // is the first concrete case for Checkpoints: arriving at the page is not the
  // same as the page being ready to read.
  await page.getByRole("row", { name: /^Balance: \S+/ }).waitFor();
}

async function capture(page: Page, slug: string, title: string): Promise<CapturedScreen> {
  // Every table on this application fills from a request that finishes after
  // the screen does, and each one has a plausible-looking empty state — an
  // empty rowgroup, or "No transactions found." Waiting on a named row catches
  // the tables we know about; this catches the ones we do not, so the committed
  // evidence is the settled screen rather than whatever had arrived by then.
  // This is transport-level settling, not targeting: no Locator is involved.
  await page.waitForLoadState("networkidle");

  const snapshot = await page.ariaSnapshot();
  return {
    slug,
    title,
    url: redactSessionIds(page.url()),
    snapshot: redactSessionIds(snapshot),
  };
}

function summarize(reviewed: ReviewedScreen[]) {
  return {
    capturedAt: new Date().toISOString(),
    surface: "parabank",
    screens: reviewed.map((item) => ({
      screen: item.title,
      url: item.url,
      snapshot: `${item.slug}.aria.yaml`,
      addressable: item.report.addressable.map(asLocator),
      unaddressable: item.report.unaddressable.map(asLocator),
      ambiguous: item.report.ambiguous,
    })),
  };
}

/** Renders a node the way a Locator names it: role plus accessible name. */
function asLocator(node: AriaNode): string {
  return node.name === undefined ? node.role : `${node.role} "${node.name}"`;
}

await main();
