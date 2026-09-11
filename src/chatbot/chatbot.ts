/**
 * The chatbot: an utterance in, a plain-language answer out, and nothing between
 * but calls to the catalog.
 *
 * It reads the catalog once, then loops: ask the router what to do next, invoke
 * it, feed the result back, and go again. Chaining lives here rather than in a
 * plan — the router decides one step at a time from what it has seen, so
 * "resolve the member, then act on them" is two turns, the second holding the
 * member number the first returned. The loop stops on the first non-success:
 * you cannot transfer from a member who was `NOT_FOUND`, and a Business Outcome,
 * a Hard Failure, or an escalation is the answer, not a step to build on.
 *
 * There is no guardrail in this file on purpose. Effects, risk, and approval are
 * the catalog's to enforce (ADR 0007); the chatbot that re-checked them would be
 * a second, weaker copy of the boundary. So it invokes whatever the router names
 * and reports whatever comes back — including a refusal, in plain language.
 */
import type { CatalogEntry } from "../catalog/catalog.js";
import type { LoginSession } from "../surface/login-session.js";
import type { CatalogClient } from "./catalog-client.js";
import type { ChatLogger } from "./log.js";
import { report } from "./report.js";
import type { IntentRouter, Invocation, Step } from "./types.js";

/**
 * A ceiling on how many Capabilities one utterance may chain, so a router that
 * never says "done" cannot loop forever. Resolve-then-act is two; a handful is
 * headroom for a request that legitimately needs a few, not a target.
 */
const MAX_STEPS = 6;

/** What the chatbot answers when no one is signed on, or the session has timed out. */
const SIGNED_OFF_MESSAGE =
  "You're not signed on. Open the sign-on portal and sign on as an operator before I can look anything up or act.";

export interface ChatbotOptions {
  /** The one dependency: how the chatbot reaches `serve`. */
  readonly client: CatalogClient;
  /** The LLM seam — mocked in tests, `modelIntentRouter` in production. */
  readonly router: IntentRouter;
  /**
   * Optional: called once per completed query with what it invoked, for the
   * chatbot query log. Omitted in tests and when no log folder is configured;
   * the chatbot does not depend on it.
   */
  readonly log?: ChatLogger;
  /**
   * The served login gate (#51). When present, a query is refused in plain
   * language until a person has signed on at the portal, and each admitted query
   * resets the idle clock. Omitted for the CLI chat command and in tests, where
   * there is no portal in the loop.
   */
  readonly session?: LoginSession;
}

/**
 * The two run-level choices the served UI exposes, applied only to a *mutating*
 * step — the catalog is still the only place risk is decided (ADR 0007), so
 * these are conveniences for the caller, not a second gate. A read-only step is
 * never paused: resolving a member is always safe, so a lookup runs and the
 * pause lands on the transfer or hold it feeds.
 */
export interface RunOptions {
  /** Stop at the first mutating step and report the plan without invoking it. */
  readonly preview?: boolean;
  /** Stop at the first mutating step and report it as pending, unless proceeding. */
  readonly confirmMutating?: boolean;
  /** Confirmation granted: run the mutating step a prior `confirmMutating` paused on. */
  readonly proceed?: boolean;
  /**
   * The exact invocation a confirm is confirming — the one the caller was shown
   * and clicked. When proceeding, this is run as-is rather than re-derived from
   * the router, so what posts is what was confirmed: the two phases are separate,
   * stateless requests, and re-asking a model between them could name a different
   * invocation than the one on the screen.
   */
  readonly confirmed?: Invocation;
}

/** A mutating step the run stopped before, and why — the caller's to preview or confirm. */
export interface PendingAction {
  readonly invocation: Invocation;
  /** The Capability reference the step named. */
  readonly ref: string;
  readonly reason: "preview" | "confirm";
}

/** One run, structured: the chain that ran, the plain-language answer, and any pause. */
export interface ChatResult {
  /** Every completed step, in order — the invocations that actually ran. */
  readonly steps: Step[];
  /** The plain-language answer, the same `ask` returns. */
  readonly answer: string;
  /** The chain hit the step ceiling while the router still wanted more. */
  readonly ranOut: boolean;
  /** Set when the run stopped before a mutating step for preview or confirmation. */
  readonly pending?: PendingAction;
  /**
   * Set when the router stopped to ask the caller a question — an under-specified
   * input on an irreversible step, rather than guess. The question is also the
   * `answer`, so a plain caller need not special-case it.
   */
  readonly asked?: string;
}

export interface Chatbot {
  /** Answer one request in plain language, chaining Capabilities as needed. */
  ask(utterance: string): Promise<string>;
  /** The same run, structured — the chain, the answer, and any pause the UI renders. */
  run(utterance: string, options?: RunOptions): Promise<ChatResult>;
}

export function createChatbot(deps: ChatbotOptions): Chatbot {
  async function run(utterance: string, options: RunOptions = {}): Promise<ChatResult> {
    // The served login gate, before anything is read or run (#51): a query is
    // refused in plain language until a person has signed on at the portal, and an
    // admitted one resets the idle clock. Nothing reaches the catalog while locked
    // out — the catalog is gated too, but this is the friendly answer.
    if (deps.session !== undefined && !deps.session.admit()) {
      const result: ChatResult = { steps: [], answer: SIGNED_OFF_MESSAGE, ranOut: false };
      deps.log?.({ utterance, options, result });
      return result;
    }

    // A confirmed action runs exactly as it was shown: the invocation the caller
    // clicked, not one re-derived by asking the router again. This is what binds
    // the confirm to the screen — the catalog still gates it, the same as any
    // other invoke.
    if (options.proceed === true && options.confirmed !== undefined) {
      const outcome = await deps.client.invoke(options.confirmed);
      const steps: Step[] = [{ invocation: options.confirmed, outcome }];
      const result: ChatResult = { steps, answer: report(steps), ranOut: false };
      deps.log?.({ utterance, options, result });
      return result;
    }

    const catalog = await deps.client.list();
    const history: Step[] = [];

    // True only if the loop ran out of steps while still wanting more — the
    // router never said "done" and the last outcome was a success it would have
    // built on. That case must not report the mid-chain success as the answer,
    // so it is told apart from a clean finish here.
    let ranOut = false;
    let pending: PendingAction | undefined;
    let asked: string | undefined;

    for (let step = 0; step < MAX_STEPS; step++) {
      const action = await deps.router(utterance, catalog, history);
      if (action.kind === "done") break;

      // The router chose to ask rather than guess — an under-specified input on
      // an irreversible step, chiefly. Stop and carry the question back; nothing
      // further is invoked, so no risky step runs on a guessed input.
      if (action.kind === "ask") {
        asked = action.question;
        break;
      }

      // Preview and confirm act on a mutating step only, and before it runs: a
      // preview reports the plan and stops; a confirm stops until the caller says
      // proceed. A read-only step is never held.
      if (isMutating(catalog, action.invocation.ref)) {
        if (options.preview) {
          pending = { invocation: action.invocation, ref: action.invocation.ref, reason: "preview" };
          break;
        }
        if (options.confirmMutating && options.proceed !== true) {
          pending = { invocation: action.invocation, ref: action.invocation.ref, reason: "confirm" };
          break;
        }
      }

      const outcome = await deps.client.invoke(action.invocation);
      history.push({ invocation: action.invocation, outcome });

      // A success is a foothold the next step can stand on; anything else is
      // where the chain ends and what the caller is told about.
      if (outcome.kind !== "success") break;

      // On the last allowed step a success is only "ran out" if the router still
      // wants to act. Ask it once more: if it is done, the chain finished exactly
      // at the cap and this success is the answer; if it wants another invoke, we
      // have genuinely hit the ceiling mid-chain. Without this, a request that
      // legitimately completes on the MAX_STEPS-th step is reported as unfinished
      // and its correct result thrown away.
      if (step === MAX_STEPS - 1) {
        const next = await deps.router(utterance, catalog, history);
        if (next.kind !== "done") ranOut = true;
      }
    }

    const answer =
      asked !== undefined
        ? asked
        : pending !== undefined
          ? pendingMessage(pending)
          : ranOut
            ? "I couldn't finish that in one go — it took more steps than I can take at once. Please try asking for one thing at a time."
            : report(history);
    const result: ChatResult = {
      steps: history,
      answer,
      ranOut,
      ...(pending !== undefined ? { pending } : {}),
      ...(asked !== undefined ? { asked } : {}),
    };
    deps.log?.({ utterance, options, result });
    return result;
  }

  return {
    run,
    async ask(utterance: string): Promise<string> {
      return (await run(utterance)).answer;
    },
  };
}

/** Whether the Capability a ref names is mutating, read off the catalog listing. */
function isMutating(catalog: readonly CatalogEntry[], ref: string): boolean {
  const id = ref.split("@")[0];
  const entry = catalog.find((e) => e.id === id);
  return entry?.contract.effects === "mutating";
}

/** The plain-language answer for a run held before a mutating step. */
function pendingMessage(pending: PendingAction): string {
  const inputs = JSON.stringify(pending.invocation.inputs);
  return pending.reason === "preview"
    ? `Preview — I would invoke ${pending.ref} with ${inputs}. Nothing was run.`
    : `Ready to invoke ${pending.ref} with ${inputs}. Confirm to post it.`;
}
