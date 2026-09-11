import { describe, expect, it } from "vitest";
import { FakeSurface, type Script } from "./fake-surface.js";
import { capturedMeridianTree, MERIDIAN_CAPTURED_BASE_URL as BASE } from "./meridian/fake-script.js";
import type { Action, Locator } from "./surface.js";

/**
 * The `readEach` primitive, checked against the MERIDIAN member record MERIDIAN
 * actually served. It is the one read that is allowed to match many rows, and
 * what is proven here is that it keeps each row's columns together — a share's
 * balance is read inside that share's row, never across the table — and that a
 * row missing or doubling a column is a miss on that row rather than a silent
 * shift of every field below it.
 *
 * The share rows are told from the header and identity rows the way the captured
 * tree tells them apart: a data row's accessible name carries a "$" balance and
 * nothing else on the screen does. The columns are the four cells of a row, by
 * position — Share ID, Type, Balance, Status.
 */
const SHARE_ROWS: Locator = { role: "row", name: "$" };
const SHARE_COLUMNS: Record<string, Locator> = {
  shareId: { role: "cell", ordinal: 0 },
  type: { role: "cell", ordinal: 1 },
  balance: { role: "cell", ordinal: 2 },
  status: { role: "cell", ordinal: 3 },
};

/** A one-screen fake serving `tree` at `url`, already navigated to it. */
async function surfaceOn(tree: string, url = `${BASE}/members/100234`): Promise<FakeSurface> {
  const script: Script = { screens: [{ name: "screen", url, tree }] };
  const surface = new FakeSurface(script);
  await surface.perform({ kind: "navigate", url });
  return surface;
}

const READ_SHARES: Action = { kind: "readEach", rows: SHARE_ROWS, columns: SHARE_COLUMNS };

describe("the readEach Surface primitive", () => {
  it("reads every share row of the captured member record into a grouped record", async () => {
    const surface = await surfaceOn(capturedMeridianTree("member-100234"));

    const result = await surface.perform(READ_SHARES);

    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    const records = result.records ?? [];

    // The captured record carries twenty shares, and each field comes from its
    // own row: the first share's balance is $2,499.00 and its status HOLD, not a
    // value borrowed from the row below it.
    expect(records).toHaveLength(20);
    expect(records[0]).toEqual({
      shareId: "100234-S0001",
      type: "Regular Shares",
      balance: "$2,499.00",
      status: "HOLD [HOLD]",
    });
    // A later row with a different status, to show the grouping holds down the
    // table rather than only at the top.
    expect(records[5]).toEqual({
      shareId: "100234-S0001-6",
      type: "Regular Shares",
      balance: "$40.00",
      status: "OPEN",
    });
    // The repeated "$25.00" balance is not ambiguous, because each is read
    // inside its own row — the whole reason readEach exists.
    expect(records.filter((record) => record["balance"] === "$25.00")).toHaveLength(3);
  });

  it("returns an empty list when the table has no data rows", async () => {
    const headerOnly = [
      "- table:",
      "  - rowgroup:",
      '    - row "Share ID Type Balance Status":',
      '      - cell "Share ID"',
      '      - cell "Type"',
      '      - cell "Balance"',
      '      - cell "Status"',
    ].join("\n");

    const result = await (await surfaceOn(headerOnly)).perform(READ_SHARES);

    // A present table with nothing in it is a value, not a miss: a member with
    // no shares is a success returning [], not a NOT_FOUND.
    expect(result).toEqual({ kind: "ok", records: [] });
  });

  it("reports a miss on the row where a column is absent, not a shifted list", async () => {
    const shortRow = [
      "- table:",
      "  - rowgroup:",
      '    - row "X-1 Regular $5.00":',
      '      - cell "X-1"',
      '      - cell "Regular"',
      '      - cell "$5.00"',
    ].join("\n");

    const result = await (await surfaceOn(shortRow)).perform(READ_SHARES);

    // The row has no fourth cell, so the status column matches nothing inside it.
    // That is a not-found on the column, never a record with three fields.
    expect(result).toEqual({ kind: "not-found", locator: SHARE_COLUMNS["status"] });
  });

  it("reports ambiguity on the row where a column matches several controls", async () => {
    const twoAmounts = [
      "- table:",
      "  - rowgroup:",
      '    - row "$1.00 and $2.00":',
      '      - cell "$1.00"',
      '      - cell "$2.00"',
    ].join("\n");
    const column: Locator = { role: "cell", name: "$" };

    const result = await (await surfaceOn(twoAmounts)).perform({
      kind: "readEach",
      rows: SHARE_ROWS,
      columns: { amount: column },
    });

    // Two "$" cells inside the row and no ordinal to choose between them: the
    // same ambiguity a single read reports, scoped to the row it happened in.
    expect(result).toEqual({ kind: "ambiguous", locator: column, matches: 2 });
  });
});
