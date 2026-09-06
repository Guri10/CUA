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
- When the request gives a member number or a name to look up, you MUST invoke the lookup capability —
  even when the number looks like a placeholder or test value (for example 999999, or all-the-same
  digits). It is not your place to decide such a member does not exist; pass it to the lookup exactly as
  given and let the result say whether it is found. A number "looking fake" is never a reason to finish.
- Call "finish" once the request is answered, or once a call you already made returned a result that
  means you cannot go on — a not-found, several members matching a name, a refusal. Never finish on an
  outcome you have not actually seen: to learn whether a member exists, invoke the lookup and let the
  result say so — do not decide in advance that a number will not be found. Do not retry a call that
  already gave one of those answers, and do not invent inputs a result told you it could not accept.
- Call "ask_user" when a capability whose effects are "mutating" needs a load-bearing input the request
  does not pin down to a single value — do NOT guess it. A mutating capability changes data and cannot
  be undone, so choosing on the caller's behalf which record it acts on is not yours to do. The clearest
  case: the request names a share by TYPE ("Regular Shares", "Money Market") but the member has more than
  one share of that type — you must not pick one. First invoke the read-only lookup that lists the
  member's shares, then, if more than one matches, call ask_user with a short question that lists the
  matching shares (id, and balance if shown) and asks which one. Only ask once you have looked; never ask
  for something a read-only call could tell you. For a read-only request, never ask — just invoke.

Do not judge whether a capability is allowed to run, or whether a lookup will succeed — invoke it and
let the catalog decide. Give a short reason with every call.`;

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

const ASK_TOOL: Anthropic.Tool = {
  name: "ask_user",
  description:
    "Stop and ask the caller to resolve an under-specified, load-bearing input on a mutating capability — " +
    "chiefly which share, when the request named only a type and the member has several matching. Do not guess instead.",
  input_schema: {
    type: "object",
    properties: {
      question: {
        type: "string",
        description: "The question to put to the caller — short, and listing the choices they must pick between.",
      },
    },
    required: ["question"],
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
      tools: [INVOKE_TOOL, FINISH_TOOL, ASK_TOOL],
      // Exactly one decision per turn: invoke the next capability, ask, or finish.
      tool_choice: { type: "any", disable_parallel_tool_use: true },
      messages: [{ role: "user", content: prompt(utterance, catalog, history) }],
    });

    const call = response.content.find((block) => block.type === "tool_use");
    if (call === undefined) return { kind: "done" };
    if (call.name === "invoke_capability") return { kind: "invoke", invocation: invocationFrom(call.input) };
    if (call.name === "ask_user") return { kind: "ask", question: questionFrom(call.input) };
    return { kind: "done" };
  };
}

/** The ask_user question, defaulted to a safe prompt if the model omitted it. */
function questionFrom(input: unknown): string {
  const question = (input as { question?: unknown }).question;
  return typeof question === "string" && question.trim() !== ""
    ? question
    : "Which one did you mean? Please name the specific share.";
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
