import { describe, expect, it } from "vitest";
import { accountLookupCapability } from "../capability/parabank/account-lookup.js";
import { capabilitySchema, type Capability } from "../capability/schema.js";
import { loadSurfaceProfile, surfacesDir, type RecoverableCondition } from "../policy/profile.js";
import { FakeSurface, type Script, type ScriptedScreen } from "../surface/fake-surface.js";
import { logInToParabank } from "../surface/parabank/login.js";
import { parabankScript, PARABANK_CAPTURED_BASE_URL as BASE } from "../surface/parabank/fake-script.js";
import type { Surface } from "../surface/surface.js";
import { replayCapability, type ReplayOptions } from "./replay.js";

/**
 * ADR 0005's middle class: a screen that is neither an answer nor a failure.
 *
 * The condition under test is the one the committed ParaBank profile actually
 * declares, matched against the login tree ParaBank actually served — loaded
 * from both rather than written out here, because a test that declares its own
 * condition proves only that the matcher works on the condition it invented.
 *
 * What is scripted is the expiry itself. The fake's once-only transition is the
 * whole point: a session that dies on the way to one screen and holds the next
 * time is the shape of every transient condition, and an application that is
 * always broken or never broken cannot express it. `replay.e2e.test.ts` injects
 * the same event into a real browser by intercepting the request.
 */
const CAPTURED_ACCOUNT = "12345";

async function parabankOptions(overrides: Partial<ReplayOptions> = {}): Promise<ReplayOptions> {
  const profile = await loadSurfaceProfile(surfacesDir(), "parabank");
  return {
    baseUrl: BASE,
    recoverableConditions: profile.recoverableConditions,
    ...overrides,
  };
}

/**
 * ParaBank, with the session dying on the way to the account detail.
 *
 * `once` on the added transition and not on the one it shadows: the first click
 * lands on the login screen, and the click after the session is re-established
 * goes where the capture said it goes.
 */
function expiringParabank(options: { readonly everyTime?: boolean } = {}): Script {
  const script = parabankScript();
  return {
    screens: script.screens.map((screen): ScriptedScreen => {
      if (screen.name !== "overview") return screen;
      return {
        ...screen,
        transitions: [
          {
            when: { kind: "click", locator: { role: "link", name: CAPTURED_ACCOUNT, exact: true } },
            to: "login",
            ...(options.everyTime === true ? {} : { once: true }),
          },
          ...(screen.transitions ?? []),
        ],
      };
    }),
  };
}

/**
 * Signing in again, which is the part no checked-in profile can hold. The
 * credentials are inert strings: the fake advances on the button being clicked
 * rather than on what was typed, which is what the real login screen does too.
 */
function signInAgain(surface: Surface): () => Promise<void> {
  return async () => {
    for (const action of logInToParabank(BASE, { username: "john", password: "demo" })) {
      await surface.perform(action);
    }
  };
}

describe("a Recoverable Condition during a Replay", () => {
  it("absorbs a session that expired mid-run and finishes the Recording", async () => {
    const surface = new FakeSurface(expiringParabank());

    const result = await replayCapability(
      surface,
      accountLookupCapability(),
      { accountId: CAPTURED_ACCOUNT },
      await parabankOptions({ reestablishSession: signInAgain(surface) }),
    );

    // The run produced the answer it was asked for — the outputs are that answer.
    // It also names the condition it absorbed to get there: recovery is no longer
    // invisible in the result, so a run that rode through an expiry can be told
    // from one that never stumbled (and shown as recovered downstream).
    expect(result).toEqual({
      kind: "success",
      outputs: { accountType: "CHECKING", balance: "-$2300.00" },
      recovered: ["SESSION_EXPIRED"],
    });
  });

  it("is preferred to a Terminal State the same screen would match", async () => {
    // The order `interpret` documents, made checkable. This Capability declares
    // an outcome that the login screen satisfies; the profile says that screen
    // is the application getting in the way, and a screen that is nobody's
    // answer must not be read as one.
    const surface = new FakeSurface(expiringParabank());

    const result = await replayCapability(
      surface,
      alsoAnswersOnTheLoginScreen(),
      { accountId: CAPTURED_ACCOUNT },
      await parabankOptions({ reestablishSession: signInAgain(surface) }),
    );

    expect(result).toMatchObject({ kind: "success" });
  });

  it("reports a condition this run was given no way to answer", async () => {
    // Detection and recovery are separate: the profile declares the screen, the
    // caller supplies the credentials. A run without the second still names
    // what it saw rather than reporting a Locator that mysteriously missed.
    const surface = new FakeSurface(expiringParabank());

    const result = await replayCapability(
      surface,
      accountLookupCapability(),
      { accountId: CAPTURED_ACCOUNT },
      await parabankOptions(),
    );

    expect(result).toMatchObject({ kind: "hard-failure", step: "wait-for-balance" });
    expect(result.kind === "hard-failure" && result.observed).toBe(
      `no control matched; the "SESSION_EXPIRED" Recoverable Condition matched, and this run was given no way to re-establish a session`,
    );
  });

  it("does not re-run a Capability that can change data", async () => {
    // Absorbing a condition means running the Recording again from Step one,
    // and a Recording that moves money run twice moves it twice. ADR 0007's
    // declared effects decide it, before the run and without a model.
    const surface = new FakeSurface(expiringParabank());

    const result = await replayCapability(
      surface,
      asMutating(accountLookupCapability()),
      { accountId: CAPTURED_ACCOUNT },
      await parabankOptions({ reestablishSession: signInAgain(surface) }),
    );

    expect(result.kind === "hard-failure" && result.observed).toContain(
      "a mutating Capability is not re-run from the start",
    );
  });

  it("stops rather than recovering forever", async () => {
    // A session that expires every time is not a transient condition, and a run
    // that kept answering it would never end.
    const surface = new FakeSurface(expiringParabank({ everyTime: true }));

    const result = await replayCapability(
      surface,
      accountLookupCapability(),
      { accountId: CAPTURED_ACCOUNT },
      await parabankOptions({ reestablishSession: signInAgain(surface), maxRecoveries: 1 }),
    );

    expect(result.kind === "hard-failure" && result.observed).toContain(
      `the "SESSION_EXPIRED" Recoverable Condition matched again, and this run may absorb only 1`,
    );
  });

  it("absorbs a `retry` condition without re-establishing a session", async () => {
    // MERIDIAN's transient maintenance page (ADR 0005's middle class, the other
    // recovery kind): the session is intact, so the run is simply attempted
    // again — with no credentials handed over, which a `re-establish-session`
    // condition would have been refused for. The once-only expiry stands in for
    // the transient screen here; what is under test is that `retry` needs no
    // `reestablishSession` to be absorbed.
    const surface = new FakeSurface(expiringParabank());
    const maintenance: RecoverableCondition = {
      name: "MAINTENANCE",
      when: { kind: "present", locator: { role: "button", name: { kind: "literal", value: "Log In" } } },
      recover: "retry",
    };

    const result = await replayCapability(
      surface,
      accountLookupCapability(),
      { accountId: CAPTURED_ACCOUNT },
      { baseUrl: BASE, recoverableConditions: [maintenance] },
    );

    expect(result).toEqual({
      kind: "success",
      outputs: { accountType: "CHECKING", balance: "-$2300.00" },
      recovered: ["MAINTENANCE"],
    });
  });

  it("leaves a screen no profile describes as a Hard Failure", async () => {
    // The same run against a profile that declares nothing. Deny-by-default in
    // the other direction: an unrecognised screen stops the run, and declaring
    // a condition is what makes it not.
    const surface = new FakeSurface(expiringParabank());

    const result = await replayCapability(
      surface,
      accountLookupCapability(),
      { accountId: CAPTURED_ACCOUNT },
      { baseUrl: BASE, reestablishSession: signInAgain(surface) },
    );

    expect(result).toMatchObject({
      kind: "hard-failure",
      step: "wait-for-balance",
      observed: "no control matched",
    });
  });
});

/** The lookup Capability, declaring an outcome the login screen also satisfies. */
function alsoAnswersOnTheLoginScreen(): Capability {
  const capability = accountLookupCapability();
  return capabilitySchema.parse({
    ...capability,
    contract: {
      ...capability.contract,
      terminalStates: [
        ...capability.contract.terminalStates,
        {
          kind: "business-outcome",
          name: "LOGGED_OUT",
          when: {
            kind: "present",
            locator: { role: "button", name: { kind: "literal", value: "Log In" } },
          },
        },
      ],
    },
  });
}

/** The same Capability, declaring that running it can change something. */
function asMutating(capability: Capability): Capability {
  return capabilitySchema.parse({
    ...capability,
    contract: { ...capability.contract, effects: "mutating" },
  });
}
