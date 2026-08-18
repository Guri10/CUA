import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { accountLookupCapability } from "../capability/parabank/account-lookup.js";
import { replayCapability } from "../replay/replay.js";
import { logInToParabank } from "../surface/parabank/login.js";
import type { Surface } from "../surface/surface.js";
import { mandateFor } from "./mandate.js";
import { openBrowserSurface } from "./open-surface.js";
import { loadSurfaceProfile, surfacesDir } from "./profile.js";
import type { SurfaceProfile } from "./profile.js";

/**
 * The gate over a real browser and a real ParaBank.
 *
 * The table-driven suite proves the rules; this proves the decorator is
 * transparent to an application that does not know it is there, and that a
 * refusal stops a browser that was perfectly capable of doing the thing.
 *
 * Needs ParaBank up — `npm run parabank:start` — and credentials in `.env`.
 */
const USERNAME = required("PARABANK_USERNAME");
const PASSWORD = required("PARABANK_PASSWORD");

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`${name} is not set. Copy .env.example to .env and fill it in.`);
  }
  return value;
}

describe("the policy gate, over a real browser", () => {
  let profile: SurfaceProfile;
  let surface: Surface;
  let close: () => Promise<void>;

  beforeAll(async () => {
    profile = await loadSurfaceProfile(surfacesDir(), "parabank");
    const mandate = mandateFor(accountLookupCapability());
    // Narrowed rather than asserted: `openBrowserSurface` takes a mandate that
    // allows something, so a refused Capability cannot reach a browser at all.
    // The type system is carrying part of ADR 0007 here.
    if (!mandate.allowed) throw new Error(mandate.reason);
    expect(mandate.mayMutate).toBe(false);

    ({ surface, close } = await openBrowserSurface(profile, mandate));
    for (const action of logInToParabank(profile.baseUrl, {
      username: USERNAME,
      password: PASSWORD,
    })) {
      expect(await surface.perform(action)).toEqual({ kind: "ok" });
    }
  });

  afterAll(async () => {
    await close();
  });

  it("is invisible to a Capability that stays inside the allowlist", async () => {
    const overview = await surface.snapshot();
    const account = overview.nodes.find(
      (node) => node.role === "link" && /^\d+$/.test(node.name ?? ""),
    );
    expect(account?.name).toBeDefined();

    const result = await replayCapability(
      surface,
      accountLookupCapability(),
      { accountId: account!.name! },
      { baseUrl: profile.baseUrl },
    );

    expect(result).toMatchObject({ kind: "success" });
  });

  it("refuses a mutating route, and the browser does not go there", async () => {
    // ParaBank is up, the session is live, and the transfer screen would load
    // perfectly well. The only thing stopping it is the profile — which is the
    // whole claim.
    const before = (await surface.snapshot()).url;

    const result = await surface.perform({
      kind: "navigate",
      url: `${profile.baseUrl}/transfer.htm`,
    });

    expect(result).toEqual({
      kind: "refused",
      reason: `"/transfer.htm" can change data, and this run has no mandate to.`,
    });
    expect((await surface.snapshot()).url).toBe(before);
  });

  it("refuses a route the profile does not list at all", async () => {
    // ParaBank's admin page can wipe the database. It is absent from both lists
    // and refused for that reason alone — deny by default, not a special case.
    const result = await surface.perform({
      kind: "navigate",
      url: `${profile.baseUrl}/nowhere.htm`,
    });

    expect(result).toMatchObject({ kind: "refused" });
    expect(result.kind === "refused" && result.reason).toMatch(/"\/nowhere\.htm" is not a route/);
  });
});
