/**
 * Captures the MERIDIAN Core member-inquiry screens the `member-lookup`
 * Capability (#22) is recorded against: the search form, and the three outcomes
 * a lookup can reach — a unique member record, no match, and several matches.
 *
 * It exists because those screens were never captured. The sign-on, menu,
 * member-record, transfer, and hold trees are committed under
 * `evidence/accessibility-tree/meridian/`, but the member search form and its
 * not-found / multiple-match results are not — and `member-lookup` cannot be
 * recorded honestly without them. The fake Surface answers from real captures
 * on purpose (see `src/surface/meridian/fake-script.ts`); a hand-written tree
 * would quietly describe the application we wish we had.
 *
 * Per ADR 0001 this targets only by role, accessible name, and ordinal — the
 * same weakest-Locator case sign-on exercises, MERIDIAN gives its inputs no
 * accessible name. Per ADR 0006 the operator password is a Secret: it has no
 * default and no literal in any tracked file, and every captured tree is run
 * through `redactSessionIds` so no live `SID` reaches a committed fixture.
 *
 * Two-phase by design, because the search form's own controls were unknown when
 * this was written and are not guessed here:
 *
 *   1. `npm run capture:meridian` with no extra args signs on and captures the
 *      empty search form at `/members` — enough to read how a search is issued.
 *      Phase 1 showed a "Search by:" combobox (`Member Number` | `Last Name`),
 *      one unnamed value textbox, and a "Search" button.
 *   2. Re-run with `search` and `probe` requests to drive that form and capture
 *      each outcome:
 *        npm run capture:meridian -- \
 *          'search:members-not-found:Member Number:999999' \
 *          'search:members-candidates:Last Name:<name matching several>'
 *      A `probe:<memberNumber>` request just logs a member's name (no file), to
 *      discover a surname shared by several members without capturing throwaway
 *      trees. Nothing about the form is assumed — the controls come from phase 1.
 *
 * Run with: npm run capture:meridian
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium, type Page } from "playwright";
import { readAriaSnapshot, reportAddressability } from "../src/surface/aria-snapshot.js";
import { redactSessionIds } from "../src/evidence/redact-session-ids.js";
import { MERIDIAN_SIGN_ON_PATH } from "../src/surface/meridian/login.js";

// A capture tool runs with no Surface profile or policy stack loaded, so it does
// not read `surfaces/meridian.json` for the origin the way Replay does — it takes
// it from the environment, defaulting to the same installation the profile names.
// Point `MERIDIAN_BASE_URL` elsewhere to capture a different installation.
const BASE_URL = (process.env["MERIDIAN_BASE_URL"] ?? "https://web-sample.interface-hiring.com").replace(
  /\/+$/,
  "",
);
const OPERATOR = required("MERIDIAN_OPERATOR");
const PASSWORD = required("MERIDIAN_PASSWORD");
const BRANCH = required("MERIDIAN_BRANCH");

/**
 * ADR 0006 classes the operator password a Secret — never written anywhere,
 * with no flag to turn that off — so it has no default here. The operator id and
 * branch are non-secret but are still read from `.env` rather than defaulted, so
 * a run says out loud what it signed on as. Copy `.env.example` to `.env` and
 * fill it in.
 */
function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`${name} is not set. Copy .env.example to .env and fill it in.`);
  }
  return value;
}

const OUTPUT_DIR = join(process.cwd(), "evidence", "accessibility-tree", "meridian");

/**
 * A request from the command line: capture the empty form, run a search and
 * capture its result, or probe one member's name without writing a file.
 */
type Request =
  | { readonly kind: "form" }
  | { readonly kind: "search"; readonly slug: string; readonly by: string; readonly value: string }
  | { readonly kind: "probe"; readonly memberNumber: string };

async function main(): Promise<void> {
  const requests = parseRequests(process.argv.slice(2));

  await mkdir(OUTPUT_DIR, { recursive: true });

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await signOn(page);

    for (const request of requests) {
      if (request.kind === "probe") {
        await probeName(page, request.memberNumber);
        continue;
      }
      if (request.kind === "form") {
        await page.goto(`${BASE_URL}/members`);
        await captureCurrent(page, "members-search");
        continue;
      }
      await runSearch(page, request.by, request.value);
      await captureCurrent(page, request.slug);
    }
  } finally {
    await browser.close();
  }
}

/** Snapshots the page as it now stands and writes it as a committed fixture. */
async function captureCurrent(page: Page, slug: string): Promise<void> {
  // Every table on this application fills from a request that finishes after the
  // screen does (see `account-lookup.ts`), so settle transport before
  // snapshotting. This is not targeting — no Locator is involved.
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
 * Drives the member-inquiry form: pick the "Search by:" mode, type the value into
 * the one unnamed textbox (by role, ADR 0001), and click Search. The controls are
 * the ones phase 1 captured, addressed by role and accessible name only.
 */
async function runSearch(page: Page, by: string, value: string): Promise<void> {
  await page.goto(`${BASE_URL}/members`);
  await page.getByRole("combobox").first().selectOption({ label: by });
  await page.getByRole("textbox").first().fill(value);
  await page.getByRole("button", { name: "Search" }).click();
}

/** Navigates to one member record and logs its name, to find a shared surname. */
async function probeName(page: Page, memberNumber: string): Promise<void> {
  await page.goto(`${BASE_URL}/members/${memberNumber}`);
  await page.waitForLoadState("networkidle");
  const nameCell = page.getByRole("row", { name: /Name:/ }).first();
  const text = (await nameCell.textContent())?.replace(/\s+/g, " ").trim() ?? "(no name row)";
  console.log(`probe ${memberNumber}: ${text}`);
}

/**
 * Signs on the same way `logInToMeridian` describes it and `capture-accessibility-tree`
 * logs into ParaBank: two unnamed textboxes by ordinal, the one branch combobox,
 * the Sign On button, then wait for the menu. Kept as direct Playwright calls
 * (not a Surface run) so this capture tool has no dependency on the replay stack.
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

/**
 * Parses the command line, defaulting to capturing the empty search form (phase
 * 1) when no requests are given. Accepts:
 *   search:<slug>:<by>:<value>   run a search and capture the result
 *   probe:<memberNumber>         log a member's name, write nothing
 * A slug must be a safe file stem so it cannot escape the evidence directory.
 */
function parseRequests(args: string[]): Request[] {
  if (args.length === 0) return [{ kind: "form" }];

  return args.map((arg): Request => {
    if (arg.startsWith("probe:")) {
      const memberNumber = arg.slice("probe:".length);
      if (!/^\d+$/.test(memberNumber)) {
        throw new Error(`probe expects a member number, got "${memberNumber}".`);
      }
      return { kind: "probe", memberNumber };
    }
    if (arg.startsWith("search:")) {
      // slug and by/value are `:`-separated; the value is the remainder so it may
      // itself contain a colon.
      const rest = arg.slice("search:".length);
      const [slug, by, ...valueParts] = rest.split(":");
      const value = valueParts.join(":");
      if (slug === undefined || by === undefined || by === "" || value === "") {
        throw new Error(`Expected search:<slug>:<by>:<value>, got "${arg}".`);
      }
      if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
        throw new Error(`Slug "${slug}" must be lower-case letters, digits, and dashes.`);
      }
      return { kind: "search", slug, by, value };
    }
    throw new Error(`Unrecognised request "${arg}". Use search:… or probe:….`);
  });
}

await main();
