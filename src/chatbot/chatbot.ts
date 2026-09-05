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
import type { CatalogClient } from "./catalog-client.js";
import { report } from "./report.js";
import type { IntentRouter, Step } from "./types.js";

/**
 * A ceiling on how many Capabilities one utterance may chain, so a router that
 * never says "done" cannot loop forever. Resolve-then-act is two; a handful is
 * headroom for a request that legitimately needs a few, not a target.
 */
const MAX_STEPS = 6;

export interface ChatbotOptions {
  /** The one dependency: how the chatbot reaches `serve`. */
  readonly client: CatalogClient;
  /** The LLM seam — mocked in tests, `modelIntentRouter` in production. */
  readonly router: IntentRouter;
}

export interface Chatbot {
  /** Answer one request, chaining Capabilities as needed. */
  ask(utterance: string): Promise<string>;
}

export function createChatbot(options: ChatbotOptions): Chatbot {
  return {
    async ask(utterance: string): Promise<string> {
      const catalog = await options.client.list();
      const history: Step[] = [];

      // True only if the loop ran out of steps while still wanting more — the
      // router never said "done" and the last outcome was a success it would have
      // built on. That case must not report the mid-chain success as the answer,
      // so it is told apart from a clean finish here.
      let ranOut = false;
      for (let step = 0; step < MAX_STEPS; step++) {
        const action = await options.router(utterance, catalog, history);
        if (action.kind === "done") break;

        const outcome = await options.client.invoke(action.invocation);
        history.push({ invocation: action.invocation, outcome });

        // A success is a foothold the next step can stand on; anything else is
        // where the chain ends and what the caller is told about.
        if (outcome.kind !== "success") break;
        if (step === MAX_STEPS - 1) ranOut = true;
      }

      if (ranOut) {
        return "I couldn't finish that in one go — it took more steps than I can take at once. Please try asking for one thing at a time.";
      }
      return report(history);
    },
  };
}
