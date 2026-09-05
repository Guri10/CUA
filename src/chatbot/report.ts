/**
 * Turning a structured outcome into plain language — the last thing the chatbot
 * does, and the one the caller actually reads.
 *
 * A pure function of the chain so far, so it is tested directly without a server
 * (ADR-style: pure functions need no seam). It reports the *last* step, because
 * that is where the chain ended: a resolve-then-act chain that reached the act
 * reports the act, and one that stopped at the resolve reports the stop. The
 * outputs are read back as the structured result the criterion asks for — a
 * confirmation number, a list of balances — never re-derived or invented.
 *
 * Two endings are called out by name because the spec calls them out:
 * `MULTIPLE_MATCHES` asks the user to narrow the search and deliberately shows
 * no candidate list (story 6, and the Capability returns none to show), and
 * `NOT_FOUND` is the clean "no such member" a lookup miss earns (story 5). Every
 * other Business Outcome is humanised from its own name rather than mapped
 * through a table the chatbot would have to grow each time recording discovers a
 * new one — the coupling the chatbot is meant not to have. A Hard Failure and an
 * escalation each get a plain, non-technical line; neither leaks a screen.
 */
import type { InvokeOutcome, Step } from "./types.js";

/** The plain-language answer for a completed chain. */
export function report(history: readonly Step[]): string {
  const last = history[history.length - 1];
  if (last === undefined) {
    return "I couldn't turn that into anything I can do here. Try naming a member and what you'd like done.";
  }
  return describe(last.outcome);
}

function describe(outcome: InvokeOutcome): string {
  switch (outcome.kind) {
    case "success":
      return reportSuccess(outcome.outputs);
    case "business-outcome":
      return reportBusinessOutcome(outcome.name);
    case "hard-failure":
      // The observed screen and URL are on the outcome for a reviewer reading
      // the run; the caller gets the fact and the step, not the dump.
      return `Something went wrong and the request couldn't be completed (it stopped at the "${outcome.step}" step). Please try again, or ask someone to look at the run.`;
    case "escalated":
      return `This action needs a person to sign off before it can run: ${outcome.context.reason} It was stopped before anything happened.`;
    case "rejected":
      return `I couldn't run that: ${outcome.error}`;
  }
}

/** Success: a sentence plus the structured result, rendered readably. */
function reportSuccess(outputs: Readonly<Record<string, unknown>>): string {
  const lines = renderValues(outputs);
  if (lines.length === 0) return "Done.";
  return ["Done. Here's what came back:", ...lines].join("\n");
}

/**
 * A Business Outcome, in the user's words. The two with their own user stories
 * are phrased by hand; the rest read their own name, lower-cased and
 * de-underscored — "insufficient funds", "source on hold" — which is already
 * plain language because the names were written to be.
 */
function reportBusinessOutcome(name: string): string {
  if (name === "MULTIPLE_MATCHES") {
    return "Several members match that. Please narrow it down — give me the member number, or a fuller last name.";
  }
  if (name === "NOT_FOUND") {
    return "I couldn't find that member. Please check the member number or name and try again.";
  }
  return `That couldn't be done: ${humanise(name)}.`;
}

/** `INSUFFICIENT_FUNDS` → `insufficient funds`. */
function humanise(name: string): string {
  return name.replace(/_/g, " ").toLowerCase();
}

/** Each output field on its own line; a list of records fans out under its name. */
function renderValues(outputs: Readonly<Record<string, unknown>>): string[] {
  const lines: string[] = [];
  for (const [name, value] of Object.entries(outputs)) {
    if (Array.isArray(value)) {
      lines.push(`${name}:`);
      for (const item of value) lines.push(`  - ${renderInline(item)}`);
    } else {
      lines.push(`${name}: ${renderInline(value)}`);
    }
  }
  return lines;
}

/** A scalar as itself; a record as its values joined, so a share reads as one line. */
function renderInline(value: unknown): string {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return Object.values(value as Record<string, unknown>)
      .map((part) => String(part))
      .join(" · ");
  }
  return String(value);
}
