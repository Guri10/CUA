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
 *
 * What happens to that Intervention Request depends on whether anybody is
 * watching. An unattended run stops and reports it, which is what every run did
 * before #11. An attended one hands the live session over instead: a person
 * does the thing the run was refused, and the loop carries on from wherever
 * they left it, with their Steps in the same list as the model's. The loop does
 * not know how a handover works — `escalate` is a function it is given, exactly
 * as `decide` is — so what it holds is only the decision to offer one and what
 * to do with the answer.
 */
import type { InterventionRequest } from "../escalation/intervention-request.js";
import type { Controller } from "../escalation/controller.js";
import { describeAction } from "../replay/describe.js";
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

/** One Action the run took, with why it was taken and by whom. */
export interface TakenStep {
  readonly action: Action;
  /**
   * Who took it. Almost always the agent; `human` for the Steps a person took
   * while they held the session during an escalation. The two live in one list
   * rather than two because they happened in one order — the run's later Steps
   * only make sense after the person's — and because what the recorder turns
   * into a Recording is the flow as it actually went.
   */
  readonly by: Controller;
  /**
   * The model's own sentence, except on the entry Step, which the loop takes
   * before the model has said anything. Printed for the operator who has to
   * judge whether a Recording is sound, and never written to evidence — ADR
   * 0006 persists a filtered transcript for exactly this reason, and prose is
   * the thing field-level masking cannot catch.
   */
  readonly reason: string;
  readonly result: ActionResult;
  /**
   * On a read, which of the run's declared return values the model says it
   * took. The recorder turns it into the Step's `bind`; a read carrying none
   * was the model looking around and is not recorded.
   */
  readonly bind?: string;
}

/**
 * Hand the live session to a person, and come back with what they did.
 *
 * A function rather than an interface, and for the reason `decide` is: there is
 * nothing here to implement twice. The real one is `handOverToHuman` closed
 * over the run's evidence and browser; the test one is a list of Actions and an
 * immediate return.
 *
 * Returning `undefined` means nobody took it — the run is unattended, and the
 * Intervention Request is the ending rather than a pause.
 */
export type Escalate = (
  request: InterventionRequest,
) => Promise<readonly Action[] | undefined>;

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
  /**
   * What to do when the gate refuses. Absent means the run is unattended and an
   * Intervention Request ends it, which is what every run did before #11.
   */
  readonly escalate?: Escalate;
  /**
   * What this run is for, named the way an Intervention Request names a
   * Capability. A recording run gives `id@version`; an exploring one has no id
   * to give, so the goal as it was typed says what the operator is being asked
   * to help with. Falls back to the entry address, which is at least where they
   * are.
   */
  readonly attempting?: string;
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
  /**
   * How long a person held the session. Subtracted from the run's own clock,
   * because a timeout is a bound on how long the automation may take and an
   * operator reading a screen is not the automation. Counting it would mean a
   * run that paused for five minutes ended the instant it resumed, throwing
   * away both the Steps it had and the ones the person had just taken.
   */
  let pausedMs = 0;
  const outOfTime = (): boolean => now() - startedAt - pausedMs > options.timeoutMs;

  /**
   * The gate refused. ADR 0007 says that is where a person decides, and this is
   * the one place the loop asks whether there is one.
   *
   * When there is, the Steps they took come back and go into the same list the
   * model's are in, and the loop carries on from the screen they left. It does
   * not retry the Action that was refused: the gate that refused it once will
   * refuse it again, and the whole point of the handover is that the thing
   * needing a person has now been done by one.
   */
  const escalated = async (refusal: string, at: TakenStep): Promise<Report | undefined> => {
    if (options.escalate === undefined) return undefined;

    const screen = await surface.snapshot();
    const pausedAt = now();
    const done = await options.escalate({
      // A Discovery Run has no Recording yet, so the Step is the Action it was
      // refused at, described — which is what an operator needs to read anyway.
      capability: options.attempting ?? options.entryUrl,
      step: describeAction(at.action),
      reason: refusal,
      observed: { url: screen.url, tree: screen.tree },
    });
    pausedMs += now() - pausedAt;
    if (done === undefined) return undefined;

    for (const action of done) {
      const step: TakenStep = {
        action,
        by: "human",
        reason: "Taken by the operator while they held the session.",
        // Already done, by a person, in the browser. There was no Locator to
        // miss and nothing dispatched that the gate could have refused.
        result: { kind: "ok" },
      };
      steps.push(step);
      options.onStep?.(step);
    }

    // The model is told, and told plainly. It asked for something it was not
    // allowed to do; what it needs to know next is that the screen has moved on
    // without it, so that it looks at where it now is rather than trying again.
    return {
      text:
        `Refused: ${refusal} A human operator took the session and has now given it back` +
        `${done.length === 0 ? ", having taken no action" : `, after ${done.length} action(s)`}.` +
        " Look at the screen as it is now and continue from there.",
      isError: false,
    };
  };

  // Step one, and the loop's own rather than the model's: the model has no
  // `navigate` verb to reach a first screen with, and a run whose Steps do not
  // include how it got there is not a Recording anybody can replay.
  const entry: Action = { kind: "navigate", url: options.entryUrl };
  const arrived = await surface.perform(entry);
  const entryStep: TakenStep = {
    action: entry,
    by: "agent",
    reason: `The run's entry point.`,
    result: arrived,
  };
  steps.push(entryStep);
  options.onStep?.(entryStep);

  if (arrived.kind === "refused") {
    // Not escalated. A run refused its own entry point never reached a screen,
    // so there is no live session to hand anybody — the operator would be given
    // a blank window and the address that was rejected.
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
      const step: TakenStep = {
        action: decision.action,
        by: "agent",
        reason: decision.reason,
        result,
        ...(decision.bind === undefined ? {} : { bind: decision.bind }),
      };
      steps.push(step);
      options.onStep?.(step);

      if (result.kind === "refused") {
        const resumed = await escalated(result.reason, step);
        if (resumed === undefined) {
          return { kind: "intervention-request", reason: result.reason, at: step, steps };
        }
        reports.push(resumed);
        continue;
      }

      reports.push(reportOf(result));
    }
  }
}

async function observe(surface: Surface): Promise<Observation> {
  const snapshot = await surface.snapshot();
  return { url: snapshot.url, tree: snapshot.tree, screenshot: await surface.screenshot() };
}
