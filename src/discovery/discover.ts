/**
 * The Discovery Run: observe, decide, act, until the goal is met or the run
 * stops.
 *
 * This is the only place a model runs at all, and it is deliberately the
 * thinnest part of the system. Everything that decides anything is either the
 * model — which this does not test — or a pure function on either side of it.
 * What is left here is the shape of the loop and the four ways it can end, and
 * those are what `discover.test.ts` holds.
 *
 * It takes a `decide` function rather than a model client. The spec rules out a
 * second seam around the model, and this is not one: there is no interface to
 * implement and no client to fake, just the one function the loop needs, whose
 * real implementation closes over a conversation and whose test implementation
 * is a list. Without it, "stops after twenty steps" and "stops when it runs out
 * of time" would be testable only by paying a model to loop twenty times.
 *
 * The Surface it is handed is already gated and already logged — it comes from
 * `openBrowserSurface` like every other one — so nothing here decides what is
 * allowed. When the gate refuses, ADR 0007 says a Discovery Run raises an
 * Intervention Request rather than acting, and that is the one refusal this
 * loop does not treat as something to work around.
 */
import type { Action, ActionResult, Surface } from "../surface/surface.js";
import { reportOf, type Decision, type Report } from "./decide.js";

export type { Decision, Report };

/** What the screen looks like right now, in the two forms the model reads. */
export interface Observation {
  readonly url: string;
  /** The accessibility tree, which is what Locators are chosen from. */
  readonly tree: string;
  /**
   * A picture of the same screen. The tree says what is there; the screenshot
   * says which of three identically-named links is the one in the row the model
   * means. It is for disambiguation, not for targeting — ADR 0001 does not let
   * a coordinate become a Locator.
   */
  readonly screenshot: Buffer;
}

/**
 * One turn: what is on the screen, and what last turn's calls produced, in the
 * order they were called.
 */
export type Decide = (
  observation: Observation,
  reports: readonly Report[],
) => Promise<readonly Decision[]>;

/** One Action the run took, with why it was taken. */
export interface TakenStep {
  readonly action: Action;
  /**
   * The model's own sentence, except on the entry Step, which the loop takes
   * before the model has said anything. Printed for the operator who has to
   * judge whether a Recording is sound, and never written to evidence — ADR
   * 0006 persists a filtered transcript for exactly this reason, and prose is
   * the thing field-level masking cannot catch.
   */
  readonly reason: string;
  readonly result: ActionResult;
}

export interface DiscoverOptions {
  /**
   * Where the run begins, as an absolute URL.
   *
   * The loop navigates there itself rather than being handed a Surface already
   * on the page, so that the entry is the first of the Steps it returns. #10
   * filters that list into a Recording, and a Recording missing the Step that
   * reaches its own first screen would replay against whatever page happened to
   * be open.
   */
  readonly entryUrl: string;
  /** How many Actions the run may take before it stops. */
  readonly maxSteps: number;
  /**
   * How long the whole run may take.
   *
   * Checked between Actions rather than enforced across one. A turn already in
   * flight — a model thinking at high effort, a page still loading — is not
   * interrupted, so a run can overrun by up to one turn. Cutting a model call
   * off mid-flight would need an abort signal threaded through the Surface as
   * well, and a run that stops a few seconds late is not the failure this
   * bound exists to prevent.
   */
  readonly timeoutMs: number;
  /** Called as each Step happens, so a run of minutes is not a silent terminal. */
  readonly onStep?: (step: TakenStep) => void;
  /** Injected so the timeout is testable without waiting for one. */
  readonly now?: () => number;
}

/**
 * How a run ended. Every member carries the Steps taken, because that list is
 * the output of a Discovery Run — #10 filters it into a Recording — and a run
 * that stopped early still took real Steps worth reading.
 */
export type DiscoveryResult =
  | {
      readonly kind: "goal-reached";
      readonly summary: string;
      readonly reason: string;
      readonly steps: readonly TakenStep[];
    }
  | {
      readonly kind: "intervention-request";
      /** The gate's own words. A human decides; the run does not retry. */
      readonly reason: string;
      readonly at: TakenStep;
      readonly steps: readonly TakenStep[];
    }
  | {
      readonly kind: "stopped";
      readonly because: "max-steps" | "timeout" | "dead-end";
      readonly steps: readonly TakenStep[];
    };

export async function discover(
  surface: Surface,
  decide: Decide,
  options: DiscoverOptions,
): Promise<DiscoveryResult> {
  const now = options.now ?? Date.now;
  const startedAt = now();
  const steps: TakenStep[] = [];
  const outOfTime = (): boolean => now() - startedAt > options.timeoutMs;

  // Step one, and the loop's own rather than the model's: the model has no
  // `navigate` verb to reach a first screen with, and a run whose Steps do not
  // include how it got there is not a Recording anybody can replay.
  const entry: Action = { kind: "navigate", url: options.entryUrl };
  const arrived = await surface.perform(entry);
  const entryStep: TakenStep = {
    action: entry,
    reason: `The run's entry point.`,
    result: arrived,
  };
  steps.push(entryStep);
  options.onStep?.(entryStep);

  if (arrived.kind === "refused") {
    return { kind: "intervention-request", reason: arrived.reason, at: entryStep, steps };
  }
  // Nowhere to explore from. Asking the model to work from a screen the run
  // never reached would waste a turn to arrive at the same answer.
  if (arrived.kind !== "ok") return { kind: "stopped", because: "dead-end", steps };

  let reports: Report[] = [];

  for (;;) {
    if (outOfTime()) return { kind: "stopped", because: "timeout", steps };
    if (steps.length >= options.maxSteps) {
      return { kind: "stopped", because: "max-steps", steps };
    }

    const decisions = await decide(await observe(surface), reports);
    // Nothing to do and no goal claimed. Asking again would get the same
    // silence, so this is where a run that has run out of ideas ends.
    if (decisions.length === 0) return { kind: "stopped", because: "dead-end", steps };

    reports = [];
    for (const decision of decisions) {
      if (decision.kind === "done") {
        return {
          kind: "goal-reached",
          summary: decision.summary,
          reason: decision.reason,
          steps,
        };
      }

      if (decision.kind === "unusable") {
        // Never an Action, so never a Step. The model is told what was wrong
        // and the loop carries on.
        reports.push({ text: decision.complaint, isError: true });
        continue;
      }

      // Checked here as well as at the top of the turn, because one turn may
      // carry several calls and the limit is on Actions taken, not on turns.
      if (steps.length >= options.maxSteps) {
        return { kind: "stopped", because: "max-steps", steps };
      }
      if (outOfTime()) return { kind: "stopped", because: "timeout", steps };

      const result = await surface.perform(decision.action);
      const step: TakenStep = { action: decision.action, reason: decision.reason, result };
      steps.push(step);
      options.onStep?.(step);

      if (result.kind === "refused") {
        return { kind: "intervention-request", reason: result.reason, at: step, steps };
      }

      reports.push(reportOf(result));
    }
  }
}

async function observe(surface: Surface): Promise<Observation> {
  const snapshot = await surface.snapshot();
  return { url: snapshot.url, tree: snapshot.tree, screenshot: await surface.screenshot() };
}
