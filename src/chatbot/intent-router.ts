/**
 * The model behind the seam: an utterance and the catalog in, the next
 * invocation out.
 *
 * This is the one place the chatbot is not deterministic, and it is deliberately
 * small — it maps language to a capability plus typed args and decides whether
 * the chain is done, and nothing else. It is not a planner: it is asked once per
 * step and shown what has happened so far, so "resolve the member, then act" is
 * the model calling the lookup, reading the number it returned, and calling the
 * act — the same one-step-at-a-time shape the Discovery loop uses, for the same
 * reason. It enforces no guardrail; every decision it makes is checked by the
 * catalog when the chatbot invokes it, which is the only boundary (ADR 0007).
 *
 * The model never sees a screen, a credential, or a raw HTTP body — only the
 * catalog's typed Contracts and the structured results of what it has already
 * invoked, which are already redacted of Secrets by the time they cross the wire.
 */
import Anthropic from "@anthropic-ai/sdk";
import type { CatalogEntry } from "../catalog/catalog.js";
import type { IntentRouter, Invocation, NextAction, Step } from "./types.js";

/**
 * The model this router uses. Named here rather than shared with the discovery
 * path's `DISCOVERY_MODEL` on purpose: the chatbot is an external caller, not
 * part of the core, and the two are free to move independently. They happen to
 * name the same model today.
 */
export const CHATBOT_MODEL = "claude-opus-5";

/** A router turn is one small decision, not an essay — this is headroom. */
const MAX_TOKENS = 2_000;

const SYSTEM = `You are a teller's assistant for a credit-union console. You do not operate any screen
yourself: you turn a request into calls to a catalog of capabilities, each with a typed contract, and
you read back what they return.

Each turn you are given the request, the catalog of capabilities you may call, and everything you have
already called this turn with its result. Decide the single next thing to do:

- Call "invoke_capability" with a capability ref and its typed inputs, matching the contract's input
  schema. Use only capabilities that are in the catalog, and only the input fields their schema names.
- To act on a member you do not yet have the number for, first invoke the lookup, then read the member
  number from its result and use it in the next call. Chain one step at a time.
- Call "finish" once the request is answered, or once a result means you cannot go on — a member that
  was not found, several members matching a name, a refusal. Do not retry a call that already gave one
  of those answers, and do not invent inputs a result told you it could not accept.

Do not judge whether a capability is allowed to run — invoke it and let the catalog decide. Give a
short reason with every call.`;

const INVOKE_TOOL: Anthropic.Tool = {
  name: "invoke_capability",
  description: "Invoke one catalog capability by reference with its typed inputs.",
  input_schema: {
    type: "object",
    properties: {
      ref: { type: "string", description: "The capability reference: <id> or <id>@<version>." },
      inputs: { type: "object", description: "The typed inputs, matching the capability's input schema." },
      variant: { type: "string", description: "Which recording to run, when a capability has more than one." },
      reason: { type: "string", description: "One sentence on why this call, now." },
    },
    required: ["ref", "inputs"],
  },
};

const FINISH_TOOL: Anthropic.Tool = {
  name: "finish",
  description: "Stop: the request is answered, or a result means the chain cannot continue.",
  input_schema: {
    type: "object",
    properties: { reason: { type: "string", description: "One sentence on why the chain is done." } },
  },
};

/**
 * A router driven by Claude, using the caller's chatbot API key. The key is read
 * from the environment (`CHATBOT_API_KEY`) — a separate key from the discovery
 * path's, as the spec asks — and never defaulted, so a missing one fails loudly
 * here rather than silently reusing another credential.
 */
export function modelIntentRouter(apiKey: string): IntentRouter {
  const client = new Anthropic({ apiKey });

  return async (utterance, catalog, history): Promise<NextAction> => {
    const response = await client.messages.create({
      model: CHATBOT_MODEL,
      max_tokens: MAX_TOKENS,
      system: SYSTEM,
      tools: [INVOKE_TOOL, FINISH_TOOL],
      // Exactly one decision per turn: invoke the next capability, or finish.
      tool_choice: { type: "any", disable_parallel_tool_use: true },
      messages: [{ role: "user", content: prompt(utterance, catalog, history) }],
    });

    const call = response.content.find((block) => block.type === "tool_use");
    if (call === undefined || call.name !== "invoke_capability") return { kind: "done" };
    return { kind: "invoke", invocation: invocationFrom(call.input) };
  };
}

/** The tool input as an `Invocation`, trusting the schema the tool declared. */
function invocationFrom(input: unknown): Invocation {
  const call = input as { ref: string; inputs?: Record<string, unknown>; variant?: string };
  return {
    ref: call.ref,
    inputs: call.inputs ?? {},
    ...(typeof call.variant === "string" ? { variant: call.variant } : {}),
  };
}

/** The one user message: the request, the catalog, and the chain so far. */
function prompt(utterance: string, catalog: readonly CatalogEntry[], history: readonly Step[]): string {
  const parts = [
    `Request: ${utterance}`,
    "",
    "Catalog (the only capabilities you may call):",
    JSON.stringify(catalog, null, 2),
  ];
  if (history.length > 0) {
    parts.push("", "Already done this turn:", JSON.stringify(history.map(stepView), null, 2));
  }
  return parts.join("\n");
}

/** What the model needs of a completed step: what was called, and what it returned. */
function stepView(step: Step): Record<string, unknown> {
  return { invoked: step.invocation.ref, inputs: step.invocation.inputs, result: step.outcome };
}
