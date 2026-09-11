import { describe, expect, it } from "vitest";
import { memberBalanceCapability } from "../capability/meridian/member-balance.js";
import { loadSurfaceProfile, surfacesDir } from "../policy/profile.js";
import {
  FakeSurface,
  type Script,
  type ScriptedScreen,
  type ScriptedTransition,
} from "../surface/fake-surface.js";
import {
  capturedMeridianTree,
  meridianMemberLookupScript,
  MERIDIAN_CAPTURED_BASE_URL as BASE,
  CAPTURED_MEMBER,
} from "../surface/meridian/fake-script.js";
import { replayCapability, type ReplayOptions } from "./replay.js";

/**
 * MERIDIAN's two Recoverable Conditions, absorbed with a bounded budget and
 * proven against the fake — the MERIDIAN half of `recoverable.test.ts` (#26).
 *
 * The conditions under test are the ones the committed MERIDIAN profile actually
 * declares — `SESSION_EXPIRED` on the 440 "Session Ended" screen (re-establish)
 * and `MAINTENANCE` on the 503 "System Maintenance" screen (retry) — loaded from
 * the profile rather than written out here, so the matcher is proven against the
 * conditions the installation ships, not ones this test invented.
 *
 * The transient itself is scripted: the fake's once-only transition throws the
 * interstitial up on the way off the inquiry form and then lets the run through
 * the second time, which is the shape of every transient condition (ADR 0005).
 * The read-only member-balance flow is the carrier, exactly as ParaBank's
 * account-lookup is in `recoverable.test.ts`.
 */
const FOUND = { memberNumber: CAPTURED_MEMBER } as const;

async function meridianOptions(overrides: Partial<ReplayOptions> = {}): Promise<ReplayOptions> {
  const profile = await loadSurfaceProfile(surfacesDir(), "meridian");
  return {
    baseUrl: BASE,
    recoverableConditions: profile.recoverableConditions,
    ...overrides,
  };
}

describe("a MERIDIAN Recoverable Condition during a Replay", () => {
  it("re-establishes the session once on SESSION_EXPIRED and finishes the run", async () => {
    const surface = new FakeSurface(interruptedBy(SESSION_ENDED));
    let reEstablished = 0;

    const result = await replayCapability(
      surface,
      memberBalanceCapability(),
      FOUND,
      await meridianOptions({
        reestablishSession: async () => {
          reEstablished += 1;
        },
      }),
    );

    // The answer the run was asked for — the outputs are that answer. The run
    // also absorbed the interstitial to get there; that it recovered is surfaced
    // on the result (see recoverable.test.ts) rather than hidden, but the outputs
    // remain what the caller reads.
    expect(result.kind).toBe("success");
    expect(result.kind === "success" && (result.outputs["shares"] as unknown[])).toHaveLength(20);
    // The session was re-established exactly once — without this the test would
    // pass on a run that never hit the interstitial at all.
    expect(reEstablished).toBe(1);
  });

  it("retries the step once on MAINTENANCE without re-establishing a session", async () => {
    // `retry` leaves the session intact, so the run is simply attempted again —
    // with no `reestablishSession` handed over, which a `re-establish-session`
    // condition would have been refused for.
    const surface = new FakeSurface(interruptedBy(SYSTEM_MAINTENANCE));

    const result = await replayCapability(
      surface,
      memberBalanceCapability(),
      FOUND,
      await meridianOptions(),
    );

    expect(result.kind).toBe("success");
    expect(result.kind === "success" && (result.outputs["shares"] as unknown[])).toHaveLength(20);
  });

  it("escalates on a second occurrence of the same condition", async () => {
    // A session that expires every time is not a transient condition. The budget
    // is one absorption per condition, so the second occurrence is a loop and is
    // escalated rather than answered forever.
    const surface = new FakeSurface(interruptedBy(SESSION_ENDED, { everyTime: true }));
    let reEstablished = 0;

    const result = await replayCapability(
      surface,
      memberBalanceCapability(),
      FOUND,
      await meridianOptions({
        reestablishSession: async () => {
          reEstablished += 1;
        },
      }),
    );

    expect(result.kind === "hard-failure" && result.observed).toContain(
      `the "SESSION_EXPIRED" Recoverable Condition matched again, and this run may absorb only 1`,
    );
    // Absorbed once and then escalated — not zero (it did recover the first
    // time) and not more (the second was the loop).
    expect(reEstablished).toBe(1);
  });

  it("keeps each condition's budget separate, so alternating conditions still terminate", async () => {
    // SESSION_EXPIRED, then MAINTENANCE, then SESSION_EXPIRED again. The middle
    // condition must not refund the first's budget: the returning SESSION_EXPIRED
    // is the loop and is escalated rather than absorbed. Were an intervening
    // condition to reset it, a run flapping between the two would never end.
    const surface = new FakeSurface(
      interruptedInTurn([SESSION_ENDED, SYSTEM_MAINTENANCE, SESSION_ENDED]),
    );
    let reEstablished = 0;

    const result = await replayCapability(
      surface,
      memberBalanceCapability(),
      FOUND,
      await meridianOptions({
        reestablishSession: async () => {
          reEstablished += 1;
        },
      }),
    );

    expect(result.kind === "hard-failure" && result.observed).toContain(
      `the "SESSION_EXPIRED" Recoverable Condition matched again, and this run may absorb only 1`,
    );
    // SESSION_EXPIRED absorbed once (and escalated on its return); MAINTENANCE
    // absorbed once in between. Only SESSION_EXPIRED re-establishes.
    expect(reEstablished).toBe(1);
  });

  it("falls through to a Hard Failure on a screen no condition describes", async () => {
    // Deny-by-default in the other direction: an injected rejection that matches
    // neither declared condition is not swept into a catch-all bucket — it stops
    // the run and says which Step, even with both conditions in force.
    const surface = new FakeSurface(interruptedBy(SYSTEM_ERROR));

    const result = await replayCapability(
      surface,
      memberBalanceCapability(),
      FOUND,
      await meridianOptions({ reestablishSession: async () => {} }),
    );

    // Exactly "no control matched", with no Recoverable Condition reason
    // appended: nothing recognised it, and nothing pretended to.
    expect(result).toMatchObject({
      kind: "hard-failure",
      step: "wait-for-results",
      observed: "no control matched",
    });
  });

  it("does not say \"again\" when a zero budget refuses the first sighting", async () => {
    // The budget-zero edge: the condition is refused the first time it is seen,
    // so the report must not claim it recurred.
    const surface = new FakeSurface(interruptedBy(SESSION_ENDED));

    const result = await replayCapability(
      surface,
      memberBalanceCapability(),
      FOUND,
      await meridianOptions({ reestablishSession: async () => {}, maxRecoveries: 0 }),
    );

    expect(result.kind === "hard-failure" && result.observed).toContain(
      `the "SESSION_EXPIRED" Recoverable Condition matched, and this run may absorb none`,
    );
    expect(result.kind === "hard-failure" && result.observed).not.toContain("matched again");
  });

  it("names the condition it saw when given no way to re-establish", async () => {
    // Detection and recovery are separate: the profile declares the screen, the
    // caller supplies the credentials. A run without the second names what it
    // saw rather than reporting a Locator that mysteriously missed.
    const surface = new FakeSurface(interruptedBy(SESSION_ENDED));

    const result = await replayCapability(
      surface,
      memberBalanceCapability(),
      FOUND,
      await meridianOptions(),
    );

    expect(result.kind === "hard-failure" && result.observed).toContain(
      `the "SESSION_EXPIRED" Recoverable Condition matched, and this run was given no way to re-establish a session`,
    );
  });
});

/**
 * The member-balance flow, with a transient interstitial thrown up on the way
 * off the inquiry form.
 *
 * `once` on the added transition and not on the one it shadows: the first Search
 * click lands on the interstitial, and the click after the run has re-run goes
 * where the capture said it goes — the unique result, on to the record. With
 * `everyTime`, the interstitial is served on every pass, which is a session that
 * is not transient at all.
 */
function interruptedBy(screen: ScriptedScreen, options: { readonly everyTime?: boolean } = {}): Script {
  const script = meridianMemberLookupScript("unique");
  return {
    screens: [
      ...script.screens.map((candidate): ScriptedScreen => {
        if (candidate.name !== "search") return candidate;
        return {
          ...candidate,
          transitions: [
            {
              when: { kind: "click", locator: { role: "button", name: "Search" } },
              to: screen.name,
              ...(options.everyTime === true ? {} : { once: true }),
            },
            ...(candidate.transitions ?? []),
          ],
        };
      }),
      screen,
    ],
  };
}

/**
 * The member-balance flow interrupted by a different interstitial on each of its
 * first passes, in turn — a run that meets one condition, recovers, then meets
 * another, then the first again. Each occurrence is a once-only transition off
 * the Search click, shadowing the normal one in the order given until they are
 * all spent, after which the click goes where the capture said it goes.
 */
function interruptedInTurn(occurrences: readonly ScriptedScreen[]): Script {
  const script = meridianMemberLookupScript("unique");
  const byName = new Map(occurrences.map((screen) => [screen.name, screen]));
  const injected: ScriptedTransition[] = occurrences.map((screen) => ({
    when: { kind: "click", locator: { role: "button", name: "Search" } },
    to: screen.name,
    once: true,
  }));
  return {
    screens: [
      ...script.screens.map((candidate): ScriptedScreen => {
        if (candidate.name !== "search") return candidate;
        return { ...candidate, transitions: [...injected, ...(candidate.transitions ?? [])] };
      }),
      ...byName.values(),
    ],
  };
}

/**
 * MERIDIAN's fault-path interstitials, from real captures.
 *
 * They appear only under fault — a session timeout, a maintenance window, a
 * server error — which the functional capture passes never triggered. MERIDIAN's
 * own `/settings` fault injection forces them per request, and
 * `capture:meridian-recoverable` snapshots the real trees under
 * `evidence/accessibility-tree/meridian/`. The fake answers from those, the same
 * rule every MERIDIAN fixture follows: a hand-written tree would quietly describe
 * the application we wish we had — and, as it happens, did: the real screens
 * carry their message as a `cell`, with no `heading` node at all, which is why
 * the profile's conditions match a cell rather than a heading.
 *
 * Each URL keeps its `?inject=…` so it cannot collide with a functional screen's
 * address when the re-run navigates back to the inquiry form.
 */
const SESSION_ENDED: ScriptedScreen = {
  name: "session-ended",
  url: `${BASE}/members/${CAPTURED_MEMBER}?inject=timeout`,
  tree: capturedMeridianTree("session-ended"),
};

const SYSTEM_MAINTENANCE: ScriptedScreen = {
  name: "system-maintenance",
  url: `${BASE}/members/${CAPTURED_MEMBER}?inject=maintenance`,
  tree: capturedMeridianTree("system-maintenance"),
};

/** A real server error — the screen no declared condition describes. */
const SYSTEM_ERROR: ScriptedScreen = {
  name: "server-error",
  url: `${BASE}/members/${CAPTURED_MEMBER}?inject=server`,
  tree: capturedMeridianTree("server-error"),
};
