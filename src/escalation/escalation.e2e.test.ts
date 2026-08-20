import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EvidenceSurface } from "../evidence/evidence-surface.js";
import { EvidenceRun } from "../evidence/run.js";
import { discoveryMandate } from "../policy/mandate.js";
import { PolicyGatedSurface } from "../policy/policy-gated-surface.js";
import { loadSurfaceProfile, surfacesDir } from "../policy/profile.js";
import { headless } from "../surface/headless.js";
import { logInToParabank } from "../surface/parabank/login.js";
import { PlaywrightSurface } from "../surface/playwright-surface.js";
import type { Action, Surface } from "../surface/surface.js";
import { SessionControl } from "./controller.js";
import { ControllerGatedSurface } from "./controller-gated-surface.js";
import { handOverToHuman } from "./handover.js";
import type { InterventionRequest } from "./intervention-request.js";

/**
 * The handover against a real browser and a real ParaBank.
 *
 * Everything else about the escalation is checked against fakes, and rightly:
 * the Controller, the endpoint and the ordering of the trail are decisions, and
 * decisions are cheaper to check without a browser. Two of #11's acceptance
 * criteria are not decisions, and only this can say them.
 *
 * The first is that the person operates *the same live session* rather than a
 * fresh one. Nothing short of a real browser can distinguish those: a fake
 * would agree it was the same object either way. Here the agent signs in, the
 * session is handed over, a person moves around inside it, and the agent then
 * reads a value off the page they left — which it could not do if the session
 * had been dropped, if a second window had been opened, or if the cookie had
 * gone with the handover.
 *
 * The second is that what the person did was captured in a vocabulary that
 * actually addresses controls. `human-actions.test.ts` checks the half that
 * runs in Node; the half that derives an accessible name runs in the page and
 * can be wrong in ways only a page can show. So every Locator the capture
 * produced is played back through `getByRole` here. If the in-page derivation
 * and Playwright disagree about what a control is called, this is where that
 * shows up rather than in a Recording that silently finds nothing — as it
 * already has once: an unlabelled `<select>` was being named after the run of
 * every option it offers, because most roles take their name from the text
 * inside them and that one does not.
 *
 * The person is played by the test, driving the page directly — which is
 * exactly what a person at the machine is doing.
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

describe("handing a real session to a person and taking it back", () => {
  let browser: Browser;
  let page: Page;
  let browserSurface: PlaywrightSurface;
  /** The full stack the commands use: Controlled(PolicyGated(Evidence(Playwright))). */
  let surface: Surface;
  let control: SessionControl;
  let evidence: EvidenceRun;
  let evidenceRoot: string;
  let accountId: string;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: headless() });
    page = await browser.newPage();
    browserSurface = new PlaywrightSurface(page);

    evidenceRoot = await mkdtemp(join(tmpdir(), "cua-escalation-"));
    evidence = await EvidenceRun.start({
      root: evidenceRoot,
      label: "escalation",
      about: { capability: "open-account@1" },
      redaction: { secrets: [PASSWORD], sensitive: [], masking: "off" },
    });

    control = new SessionControl();
    surface = new ControllerGatedSurface(
      new PolicyGatedSurface(
        new EvidenceSurface(browserSurface, evidence),
        await loadSurfaceProfile(surfacesDir(), "parabank"),
        discoveryMandate(),
      ),
      control,
    );

    for (const action of logInToParabank(BASE_URL, { username: USERNAME, password: PASSWORD })) {
      expect(await surface.perform(action)).toEqual({ kind: "ok" });
    }

    const overview = await surface.snapshot();
    const account = overview.nodes.find(
      (node) => node.role === "link" && /^\d+$/.test(node.name ?? ""),
    );
    expect(account?.name).toBeDefined();
    accountId = account!.name!;
  });

  afterAll(async () => {
    await browser.close();
    await rm(evidenceRoot, { recursive: true, force: true });
  });

  it("pauses, records what the person does, resumes, and leaves the session intact", async () => {
    const request: InterventionRequest = {
      capability: "account-lookup@1",
      step: "read the balance",
      reason: "A test is standing in for a Step the gate refused.",
      observed: { url: (await surface.snapshot()).url, tree: (await surface.snapshot()).tree },
    };
    const announced: string[] = [];

    const handover = handOverToHuman({
      control,
      evidence,
      request,
      capture: (onAction) => browserSurface.captureHumanActions(onAction),
      port: 0,
      announce: (message) => announced.push(message),
    });

    // While the person holds it, the agent is refused — the spec's "we cannot
    // both drive at once", against the real stack rather than a fake one.
    expect(await surface.perform({ kind: "click", locator: { role: "link", name: "Log Out" } })).toMatchObject({
      kind: "refused",
    });

    // The person, at the machine, using the window that is already open. Two
    // verbs: one that navigates, and one that changes a control's value.
    await page.getByRole("link", { name: accountId, exact: true }).click();
    await page.getByRole("combobox").first().selectOption({ index: 1 });

    await resumeThrough(announced);
    const { actions } = await handover;

    expect(control.controller).toBe("agent");
    expect(actions.map((action) => action.kind)).toEqual(["click", "select"]);

    // The same session, still signed in, on the screen the person left it on —
    // which is the acceptance criterion nothing but a real browser can show.
    // Checked before anything moves the page, because "where they left it" is
    // half of what is being claimed.
    const after = await surface.snapshot();
    expect(after.url).toContain("activity.htm");
    expect(after.nodes.some((node) => node.role === "link" && node.name === "Log Out")).toBe(true);
    expect(await surface.perform({ kind: "read", locator: { role: "heading", name: "Account Details" } }))
      .toMatchObject({ kind: "ok" });

    // The Locators the capture derived, replayed through Playwright's own
    // role-based query — the check that the in-page name derivation and
    // Playwright agree about what a control is called. Each is looked for on
    // the screen it was used on, which for the person's first Action is the one
    // their own click navigated away from.
    const [clicked, chosen] = actions;
    expect(await surface.perform(waitFor(chosen!))).toEqual({ kind: "ok" });

    expect(await surface.perform({ kind: "navigate", url: `${BASE_URL}/overview.htm` })).toEqual({
      kind: "ok",
    });
    expect(await surface.perform(waitFor(clicked!))).toEqual({ kind: "ok" });
  });

  it("writes one trail saying which Actions were the agent's and which the person's", async () => {
    const log = await readFile(join(evidence.directory, "run.jsonl"), "utf8");
    const records = log.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);

    const acted = records.filter((record) => record["kind"] === "action");
    // The auditor's user story: every action, by whom. Both authors are in the
    // one file, in the order they acted.
    expect(new Set(acted.map((record) => record["by"]))).toEqual(new Set(["agent", "human"]));
    expect(records.map((record) => record["kind"])).toContain("intervention-request");
    expect(
      records.filter((record) => record["kind"] === "control").map((record) => record["to"]),
    ).toEqual(["human", "agent"]);
  });
});

/** The captured Action as a check that its Locator still addresses one control. */
function waitFor(action: Action): Action {
  if (action.kind === "navigate") throw new Error("A capture never produces a navigate.");
  return { kind: "waitFor", locator: action.locator };
}

/** Reads the endpoint out of what the operator was told, and resumes through it. */
async function resumeThrough(announced: string[]): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const url = announced.join("\n").match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
    if (url !== undefined) {
      expect((await fetch(`${url}/resume`, { method: "POST" })).status).toBe(200);
      return;
    }
    await new Promise((settle) => setTimeout(settle, 25));
  }
  throw new Error("The pause never announced an endpoint to resume through.");
}
