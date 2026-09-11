import { describe, expect, it } from "vitest";
import { capabilitiesDir, listCapabilities, loadCapabilityRef } from "../capability/storage.js";
import type { Capability } from "../capability/schema.js";
import { loadSurfaceProfile, surfacesDir, type SurfaceProfile } from "./profile.js";

/**
 * A Surface profile's `actions` allowlist is the policy gate's whitelist: a
 * committed Capability that performs an action its profile omits is refused at
 * that step (`policy-gated-surface.ts`) and the run hard-fails — but only on the
 * gated path (`serve`, the CLI). A bare-Surface replay in a unit test or a direct
 * e2e never sees the gate, so an omission hides there and only surfaces when the
 * Capability is invoked through the catalog. That is exactly how `member-balance`
 * reached production with its `readEach` step missing from the `meridian`
 * allowlist: green in every replay test, a hard failure the first time the
 * chatbot drove it.
 *
 * This closes that gap for every Capability at once — no browser, no gate, just
 * the two committed artifacts checked against each other: the actions a Recording
 * performs, and the actions its profile permits.
 */

/**
 * Every action kind the Capability's recordings perform — the base variant's
 * steps, plus any action a Tenant variant patches in (a patch replaces a Step's
 * whole action, so it can introduce a kind the base never used).
 */
function actionKindsOf(capability: Capability): Set<string> {
  const kinds = new Set<string>();
  for (const recording of capability.recordings) {
    if ("steps" in recording) {
      for (const step of recording.steps) kinds.add(step.action.kind);
    } else {
      for (const patch of Object.values(recording.patch)) kinds.add(patch.action.kind);
    }
  }
  return kinds;
}

describe("a Surface profile permits every action its Capabilities perform", () => {
  it("no committed Capability uses an action its profile's allowlist omits", async () => {
    const ids = await listCapabilities(capabilitiesDir());
    expect(ids.length).toBeGreaterThan(0);

    const profiles = new Map<string, SurfaceProfile>();
    const profileFor = async (surface: string): Promise<SurfaceProfile> => {
      const cached = profiles.get(surface);
      if (cached !== undefined) return cached;
      const loaded = await loadSurfaceProfile(surfacesDir(), surface);
      profiles.set(surface, loaded);
      return loaded;
    };

    const gaps: string[] = [];
    for (const id of ids) {
      const capability = await loadCapabilityRef(capabilitiesDir(), id);
      const permitted = new Set<string>((await profileFor(capability.surface)).actions);
      for (const kind of actionKindsOf(capability)) {
        if (!permitted.has(kind)) {
          gaps.push(`${capability.id}@${capability.version} performs "${kind}", which the "${capability.surface}" profile does not permit`);
        }
      }
    }

    expect(gaps).toEqual([]);
  });
});
