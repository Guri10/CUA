/**
 * The model, as one function.
 *
 * `modelDecider` closes over a conversation and hands back the `Decide` the
 * loop takes, which is why there is no client interface anywhere in this
 * codebase: the loop needs one function, and this produces it.
 *
 * What the model is given each turn is the accessibility tree of the screen it
 * is on, a picture of the same screen for disambiguation, and what its last
 * calls produced. What it is never given is a credential — the run is signed in
 * before the loop starts, exactly as Replay is, so the application password
 * does not enter the conversation at all. ADR 0006 calls that a Secret, and the
 * cheapest way to keep one out of a transcript is to never put it there.
 */
import Anthropic from "@anthropic-ai/sdk";
import { decisionFor } from "./decide.js";
import type { Decide, Decision, Observation, Report } from "./discover.js";
import { discoveryToolDefinitions } from "./tools.js";

/** The model the spec names, and the only one this path uses. */
export const DISCOVERY_MODEL = "claude-opus-5";

/**
 * Enough for a turn that thinks hard and then calls one tool. A Discovery Run
 * turn produces a single tool call, not an essay, so this is headroom rather
 * than a target.
 */
const MAX_TOKENS = 16_000;

export interface ModelOptions {
  readonly goal: string;
  /** Where the run starts, named in the prompt so the model knows where it is. */
  readonly entry: string;
}

const SYSTEM = `You are operating a legacy web application through its accessibility tree, the way a
screen-reader user would. You cannot see coordinates and you cannot write selectors: a control is
addressed by its ARIA role and its accessible name, optionally scoped by an enclosing control and
disambiguated by a zero-based ordinal.

Each turn you are given the accessibility tree of the current screen, a screenshot of the same
screen, and the result of whatever you last did. Take one action at a time and read what came back
before deciding the next one.

Rules:
- Address controls only with the role and name you can actually see in the tree.
- Several controls may share a name. Use "exact" when a name is a prefix of another, and "ordinal"
  when the tree genuinely shows several.
- A page may render before its content arrives. If a value you need is not there yet, wait for it.
- If an action reports that no control matched, do not repeat it unchanged. Re-read the tree.
- You are already signed in. Do not look for a login form and never type a credential.
- Some actions will be refused by a policy gate. That is final: a refusal is not something to work
  around, and the run will stop for a person to look at.
- Read every value the goal asks for with the "read" tool, even when you can already see it in the
  tree. What you do here is being recorded and will be replayed later without you, and only a
  "read" becomes a value that comes back. Seeing it is not reading it.
- Address a control by something that will still be true next time, never by the value it happens to
  hold today. A value shown in a labelled row is reached by scoping to that row and taking the cell
  by ordinal — not by naming the number currently in it. A control addressed by today's balance
  finds nothing tomorrow.
- Call "done" once the goal is met, with the values you read in its summary.

Give a one-sentence reason with every call. It is shown to the engineer who has to decide whether
what you did is worth keeping.`;

export function modelDecider(options: ModelOptions): Decide {
  const client = new Anthropic();
  const messages: Anthropic.Beta.BetaMessageParam[] = [];
  /** The ids of last turn's calls, in the order the loop reports on them. */
  let pending: string[] = [];

  return async (observation: Observation, reports: readonly Report[]) => {
    messages.push({ role: "user", content: turnContent(options, observation, reports, pending) });

    const response = await client.beta.messages.create({
      model: DISCOVERY_MODEL,
      max_tokens: MAX_TOKENS,
      // The spec names both: adaptive thinking, at high effort.
      thinking: { type: "adaptive" },
      output_config: { effort: "high" },
      // A screen is driven one control at a time. Two clicks dispatched together
      // would be judged against a page that the first of them had already left.
      tool_choice: { type: "auto", disable_parallel_tool_use: true },
      tools: discoveryToolDefinitions(),
      system: SYSTEM,
      // The system prompt and the tool list are identical every turn, so the
      // growing history is the only thing paid for in full.
      cache_control: { type: "ephemeral" },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      messages,
    });

    // Echoed back whole, thinking blocks included: they belong to the turn and
    // the next request has to carry them unchanged.
    messages.push({ role: "assistant", content: response.content });

    if (response.stop_reason === "refusal") {
      // Not the policy gate's kind of refusal — the model itself declined. There
      // is nothing to hand back to it, so the run reads this as a dead end.
      return [];
    }

    // A list, because the API returns one — even though the request above asks
    // for a single call per turn. The loop dispatches whatever arrives in order
    // rather than taking the first and dropping the rest, which is the failure
    // that would look like the model changing its mind.
    const calls = response.content.filter((block) => block.type === "tool_use");
    pending = calls.map((call) => call.id);
    return calls.map((call): Decision => decisionFor(call.name, call.input));
  };
}

/**
 * One user turn: the results of what was asked for last, then the screen as it
 * is now.
 *
 * The results come first because the API requires every `tool_use` to be
 * answered by a `tool_result` at the head of the next user message, and the
 * fresh observation follows in the same message rather than a second one.
 */
function turnContent(
  options: ModelOptions,
  observation: Observation,
  reports: readonly Report[],
  pending: readonly string[],
): Anthropic.Beta.BetaContentBlockParam[] {
  const results = pending.map(
    (id, index): Anthropic.Beta.BetaContentBlockParam => ({
      type: "tool_result",
      tool_use_id: id,
      // A call the loop never got to — it stopped first — is answered honestly
      // rather than left dangling, which the API would reject.
      content: reports[index]?.text ?? "not run",
      is_error: reports[index]?.isError ?? true,
    }),
  );

  const opening =
    pending.length === 0
      ? [`Goal: ${options.goal}`, `You are starting at ${options.entry}.`].join("\n")
      : "";

  return [
    ...results,
    {
      type: "image",
      source: {
        type: "base64",
        media_type: "image/png",
        data: observation.screenshot.toString("base64"),
      },
    },
    {
      type: "text",
      text: [opening, `Screen: ${observation.url}`, "", observation.tree]
        .filter((part) => part !== "")
        .join("\n"),
    },
  ];
}
