import { describe, expect, it } from "vitest";
import type { CatalogEntry } from "../catalog/catalog.js";
import type { RunSummary } from "./history.js";
import { renderDashboard, type DashboardModel } from "./render.js";

/**
 * The dashboard is server-rendered HTML with no client code, so the test is the
 * page: what a person watching the system would read. It checks the two halves
 * are shown, that a status carries its label, that empty halves say so rather
 * than looking broken, and — because run values reach the page from a log — that
 * a value carrying markup is escaped rather than rendered.
 */
describe("dashboard render", () => {
  const entry = (over: Partial<CatalogEntry> = {}): CatalogEntry => ({
    id: "account-lookup",
    version: 1,
    contract: {
      summary: "Look up an account's type and balance by number.",
      inputs: { type: "object", properties: { accountId: { type: "string" } }, required: ["accountId"] },
      outputs: { type: "object", properties: { balance: { type: "string" } } },
      effects: "read-only",
      // render does not read terminalStates; a placeholder keeps the fixture honest.
      terminalStates: [] as unknown as CatalogEntry["contract"]["terminalStates"],
    },
    ...over,
  });

  const run = (over: Partial<RunSummary> = {}): RunSummary => ({
    id: "2026-09-01T00-00-00.000Z-replay-account-lookup-a",
    kind: "replay",
    capability: "account-lookup@1",
    startedAt: "2026-09-01T00:00:00.000Z",
    finishedAt: "2026-09-01T00:00:05.000Z",
    status: "success",
    inputs: [{ name: "accountId", value: "[SENSITIVE]" }],
    result: [],
    actionCount: 12,
    readCount: 2,
    hasFailureScreenshot: false,
    ...over,
  });

  const model = (over: Partial<DashboardModel> = {}): DashboardModel => ({
    catalog: [entry()],
    runs: [run()],
    generatedAt: "2026-09-04T00:00:00.000Z",
    ...over,
  });

  it("shows the catalog entry with its summary and effects", () => {
    const html = renderDashboard(model());
    expect(html).toContain("account-lookup");
    expect(html).toContain("Look up an account&#39;s type and balance by number.");
    expect(html).toContain("read-only");
  });

  it("shows a run with its status label, inputs, and read count", () => {
    const html = renderDashboard(model());
    expect(html).toContain("account-lookup@1");
    expect(html).toContain("Success");
    expect(html).toContain("accountId");
    expect(html).toContain("[SENSITIVE]");
    expect(html).toContain("2"); // read count
  });

  it("gives each display status a distinct human label", () => {
    const statuses: RunSummary["status"][] = [
      "success",
      "recovered",
      "business-outcome",
      "failed",
      "escalated",
      "stopped",
      "incomplete",
    ];
    const html = renderDashboard(model({ runs: statuses.map((status, i) => run({ id: `r${i}`, status })) }));
    for (const label of ["Success", "Recovered", "Business outcome", "Failed", "Escalated", "Stopped", "Incomplete"]) {
      expect(html).toContain(label);
    }
  });

  it("names the recovered condition and the business outcome", () => {
    const html = renderDashboard(
      model({
        runs: [
          run({ id: "a", status: "recovered", recoveredFrom: "SESSION_EXPIRED" }),
          run({ id: "b", status: "business-outcome", businessOutcome: "ACCOUNT_NOT_FOUND" }),
        ],
      }),
    );
    expect(html).toContain("SESSION_EXPIRED");
    expect(html).toContain("ACCOUNT_NOT_FOUND");
  });

  it("links the failure screenshot only when there is one", () => {
    const withShot = renderDashboard(model({ runs: [run({ id: "shot-run", hasFailureScreenshot: true })] }));
    expect(withShot).toContain("/runs/shot-run/failure.png");

    const without = renderDashboard(model({ runs: [run({ hasFailureScreenshot: false })] }));
    expect(without).not.toContain("failure.png");
  });

  it("escapes markup coming from logged values", () => {
    const html = renderDashboard(
      model({ runs: [run({ inputs: [{ name: "note", value: "<script>alert(1)</script>" }] })] }),
    );
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("says so when the catalog is empty", () => {
    const html = renderDashboard(model({ catalog: [] }));
    expect(html).toMatch(/no approved capabilities/i);
  });

  it("says so when there is no run history", () => {
    const html = renderDashboard(model({ runs: [] }));
    expect(html).toMatch(/no runs/i);
  });

  it("is a whole HTML document", () => {
    const html = renderDashboard(model());
    expect(html.trimStart().toLowerCase()).toMatch(/^<!doctype html>/);
  });
});
