/**
 * Captures the MERIDIAN Core fault-path interstitials the recoverable-condition
 * Replay (#26) is proven against: the "session timed out" screen `SESSION_EXPIRED`
 * matches, the "scheduled maintenance" screen `MAINTENANCE` matches, and a plain
 * server error, which no condition describes and which must fall through to a Hard
 * Failure.
 *
 * These screens were never captured because they appear only under fault, which
 * the functional capture passes never triggered. MERIDIAN's own `/settings`
 * fault-injection forces them per request with an `?inject=<mode>` query
 * parameter — a testing hook, used here only to capture the real trees and never
 * wired into the system. `recoverable.meridian.test.ts` then answers from these
 * captures instead of a hand-written tree, the same rule every MERIDIAN fixture
 * follows (see `src/surface/meridian/fake-script.ts`).
 *
 * Per ADR 0006 the operator password is a Secret — no default, no literal in any
 * tracked file — and every captured tree is run through `redactSessionIds` so no
 * live `SID` reaches a committed fixture. Sign-on uses the supervisor operator
 * because fault injection is a supervisor feature.
 *
 * `inject=timeout` actually ends the session, so it is captured last.
 *
 * Run with: npm run capture:meridian-recoverable
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
const OPERATOR = required("MERIDIAN_SUPERVISOR_OPERATOR");
const PASSWORD = required("MERIDIAN_SUPERVISOR_PASSWORD");
const BRANCH = required("MERIDIAN_BRANCH");

/**
 * ADR 0006 classes the operator password a Secret — never written anywhere, with
 * no flag to turn that off — so it has no default here. Copy `.env.example` to
 * `.env` and fill it in.
 */
function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`${name} is not set. Copy .env.example to .env and fill it in.`);
  }
  return value;
}

const OUTPUT_DIR = join(process.cwd(), "evidence", "accessibility-tree", "meridian");

/** The member a fault is forced on the way to; the fault renders before the record does. */
const MEMBER = "100234";

/**
 * The interstitials to capture, in order. `timeout` ends the session, so it is
 * last: anything after it would capture a signed-out screen.
 */
const CAPTURES: ReadonlyArray<{ readonly slug: string; readonly inject: string }> = [
  { slug: "system-maintenance", inject: "maintenance" },
  { slug: "server-error", inject: "server" },
  { slug: "session-ended", inject: "timeout" },
];

async function main(): Promise<void> {
  await mkdir(OUTPUT_DIR, { recursive: true });

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await signOn(page);

    for (const { slug, inject } of CAPTURES) {
      await page.goto(`${BASE_URL}/members/${MEMBER}?inject=${inject}`);
      await captureCurrent(page, slug);
    }
  } finally {
    await browser.close();
  }
}

/** Snapshots the page as it now stands and writes it as a committed fixture. */
async function captureCurrent(page: Page, slug: string): Promise<void> {
  await page.waitForLoadState("networkidle");

  const tree = redactSessionIds(await page.ariaSnapshot());
  const report = reportAddressability(readAriaSnapshot(tree));
  const file = join(OUTPUT_DIR, `${slug}.txt`);
  await writeFile(file, `URL: ${redactSessionIds(page.url())}\n\n${tree}\n`, "utf8");
  console.log(
    `${slug}: ${report.addressable.length} addressable, ` +
      `${report.unaddressable.length} unnamed, ${report.ambiguous.length} ambiguous -> ${file}`,
  );
}

/**
 * Signs on the same way `capture-meridian-members` does: two unnamed textboxes by
 * ordinal, the one branch combobox, the Sign On button, then wait for the menu.
 */
async function signOn(page: Page): Promise<void> {
  await page.goto(`${BASE_URL}${MERIDIAN_SIGN_ON_PATH}`);

  const textboxes = page.getByRole("textbox");
  await textboxes.nth(0).fill(OPERATOR);
  await textboxes.nth(1).fill(PASSWORD);
  await page.getByRole("combobox").first().selectOption({ label: BRANCH });
  await page.getByRole("button", { name: "Sign On" }).click();
  await page.getByRole("heading", { name: "MAIN MENU" }).waitFor();
}

await main();

export {};
