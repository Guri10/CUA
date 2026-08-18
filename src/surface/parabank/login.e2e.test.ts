import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PlaywrightSurface } from "../playwright-surface.js";
import { logInToParabank } from "./login.js";
import type { ActionResult, Locator } from "../surface.js";

/**
 * The other half of the pair. `login.test.ts` runs this same list of Actions
 * against a scripted fake with no browser; this runs it against a real Chromium
 * driving the real application.
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

describe("logging in to ParaBank, through a real browser", () => {
  let surface: PlaywrightSurface;

  beforeAll(async () => {
    surface = await PlaywrightSurface.launch();
  });

  afterAll(async () => {
    await surface.close();
  });

  it("runs the same interaction the fake runs", async () => {
    const actions = logInToParabank(BASE_URL, { username: USERNAME, password: PASSWORD });
    const results: ActionResult[] = [];
    for (const action of actions) results.push(await surface.perform(action));

    expect(results).toHaveLength(6);
    expect(results.every((result) => result.kind === "ok")).toBe(true);

    const snapshot = await surface.snapshot();
    expect(snapshot.url).toContain("overview.htm");
    expect(snapshot.tree).toContain(`- heading "Accounts Overview"`);
    // Logged in rather than merely on the page: the menu only offers this once
    // there is a session to end.
    expect(snapshot.nodes.some((node) => node.role === "link" && node.name === "Log Out")).toBe(
      true,
    );
  });

  it("reads a balance by scoping a cell to the row that names the field", async () => {
    // The flagship Capability's whole job, and the reason ADR 0001 survived
    // ticket 2: both cells in the row are named for their contents, so only the
    // enclosing row says which is the balance.
    const accounts = await surface.snapshot();
    const account = accounts.nodes.find((node) => node.role === "link" && /^\d+$/.test(node.name ?? ""));
    expect(account?.name).toBeDefined();

    const opened = await surface.perform({
      kind: "click",
      locator: { role: "link", name: account!.name!, exact: true, ordinal: 0 },
    });
    expect(opened).toEqual({ kind: "ok" });

    // The Checkpoint the accessibility survey argued for, and the reason this
    // test failed before it was here. This page renders its labels immediately
    // and fills the value cells from a later request, so reading straight after
    // the click returns an empty cell and nothing errors — `row "Balance:"`
    // next to a blank. Waiting on the heading would not have helped; it is
    // already there. Waiting for a row whose name has picked up a currency
    // amount is the closest the Locator vocabulary comes to "the value has
    // arrived", and on this page the account table precedes the transaction
    // table, so the first such row is this one.
    expect(await surface.perform({ kind: "waitFor", locator: { role: "row", name: "$", ordinal: 0 } })).toEqual(
      { kind: "ok" },
    );

    const balance = await surface.perform({
      kind: "read",
      locator: { role: "cell", ordinal: 1, within: { role: "row", name: "Balance:" } },
    });

    expect(balance.kind).toBe("ok");
    expect(balance.kind === "ok" && balance.value).toMatch(/^-?\$[\d,]+\.\d{2}$/);
  });

  it("reports a control that is not on the screen instead of throwing", async () => {
    const locator: Locator = { role: "button", name: "Wire Transfer" };

    // A short wait on purpose: this asserts the absent case, and the default
    // would spend ten seconds proving something already known.
    expect(await surface.perform({ kind: "waitFor", locator, timeoutMs: 2_000 })).toEqual({
      kind: "not-found",
      locator,
    });
  });

  it("reads a control's chosen option the same way the fake does", async () => {
    // The pair's sharpest case. Nobody has touched this filter, so there is no
    // typed value to fall back on and the answer has to come from the tree
    // itself — where the chosen option is marked. `fake-surface.test.ts` makes
    // exactly this assertion against a scripted screen; the two agreeing is
    // what the second implementation is for.
    const filter = await surface.perform({
      kind: "read",
      locator: { role: "combobox", within: { role: "row", name: "Type:" } },
    });

    expect(filter).toEqual({ kind: "ok", value: "All" });
  });
});
