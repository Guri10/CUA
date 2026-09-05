/**
 * The chatbot's vocabulary, in one place so the loop, the report, and the LLM
 * seam share it without importing each other.
 *
 * The chatbot is a pure caller of the catalog API (`serve`). It never decides
 * risk, effects, or approval — `serve` is the only security boundary (ADR 0007).
 * What it owns is turning an utterance into invocation(s), chaining them
 * (resolve a member, then act), and telling the caller what happened in plain
 * language. The types here draw the two lines that keeps that honest: an
 * `Invocation` is exactly what crosses the wire to `serve`, and an
 * `InvokeOutcome` is exactly what comes back — the same discriminated union a
 * direct Replay returns, plus the `escalated` status the catalog can reach and
 * the `rejected` shape a malformed request comes back as. The chatbot reads
 * these; it does not widen them.
 */
import type { CatalogEntry } from "../catalog/catalog.js";
import type { Escalated } from "../catalog/serve.js";
import type { ReplayResult } from "../replay/replay.js";

/** One call to `serve`: which Capability, its typed inputs, and an optional variant. */
export interface Invocation {
  /** A Capability reference the way the command line names one: `<id>` or `<id>@<version>`. */
  readonly ref: string;
  /** The typed inputs, already JSON — the shape the Contract will validate. */
  readonly inputs: Readonly<Record<string, unknown>>;
  /** Which Tenant's Recording to run, when a Capability has more than one. */
  readonly variant?: string;
}

/**
 * How one invocation ended, as the chatbot sees it over HTTP.
 *
 * The first three are the Replay union `serve` returns unchanged (a `200`
 * success or Business Outcome, a `502` Hard Failure); `escalated` is the `403`
 * pre-run gate refusal; `rejected` is a `4xx` the caller caused — an unknown
 * Capability, a malformed reference, or inputs the Contract turned away. The
 * chatbot never invents an outcome the wire did not carry: an unrecognised
 * status becomes a `rejected`, never a silent success.
 */
export type InvokeOutcome =
  | ReplayResult
  | Escalated
  | {
      readonly kind: "rejected";
      /** The HTTP status the catalog answered with. */
      readonly status: number;
      /** Why, in the catalog's own words. */
      readonly error: string;
    };

/** One completed step of a chain: what was invoked, and what came back. */
export interface Step {
  readonly invocation: Invocation;
  readonly outcome: InvokeOutcome;
}

/**
 * What the router decides to do next, given the utterance and what has happened
 * so far: invoke one more Capability, or stop because the request is answered
 * (or cannot be turned into an invocation).
 */
export type NextAction =
  | { readonly kind: "invoke"; readonly invocation: Invocation }
  | { readonly kind: "done" };

/**
 * The one seam a model lives behind: an utterance, the catalog it may call, and
 * the chain so far in, one `NextAction` out. Called once per step, so chaining
 * emerges from the loop rather than from a plan the router draws up front — the
 * router sees the member it just resolved and decides to act on it, exactly as
 * the Discovery loop's `Decide` sees the screen it just reached. Stubbed cleanly
 * in tests; the real one drives Claude (`modelIntentRouter`).
 */
export type IntentRouter = (
  utterance: string,
  catalog: readonly CatalogEntry[],
  history: readonly Step[],
) => Promise<NextAction>;
