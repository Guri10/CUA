/**
 * The one seam. Everything that touches a screen goes through these three
 * methods, and everything that does not is a pure function tested without a
 * seam at all.
 *
 * Two implementations sit behind it — a real browser and an in-memory fake
 * driven by a scripted state machine. The fake is not a test convenience: it is
 * the evidence that this abstraction actually holds, and it is the same
 * argument for a desktop Surface reading platform accessibility APIs instead of
 * a browser's.
 *
 * The policy gate and the evidence log arrive later as decorators implementing
 * this same interface, composed as `PolicyGated(Evidence(real | fake))`. That
 * is why `Surface` stays at exactly three methods: every method added here is a
 * method every decorator has to forward correctly.
 */
import type { AriaNode } from "./aria-snapshot.js";
import type { AriaRole } from "./aria-roles.js";

export interface Surface {
  /** What is on the screen right now. */
  snapshot(): Promise<Snapshot>;
  /** Do one thing to the screen. */
  perform(action: Action): Promise<ActionResult>;
  /** A picture of the screen, for evidence and for disambiguating a snapshot. */
  screenshot(): Promise<Buffer>;
}

/**
 * How a Step identifies its control, per ADR 0001: an accessibility role and an
 * accessible name, optionally scoped by a parent and disambiguated by ordinal.
 * Deliberately not a CSS or XPath expression.
 *
 * Every field beyond `role` exists because ParaBank needs it. The login inputs
 * carry no accessible name at all and are reachable only as the first and
 * second `textbox`, so `ordinal` is load-bearing from the first Recording. The
 * account detail filters are two unnamed comboboxes distinguished only by their
 * enclosing row, so `within` nests rather than being a single parent. And the
 * overview lists account numbers as links whose names are prefixes of one
 * another, so `exact` decides whether `12345` may match `123456`.
 */
export interface Locator {
  readonly role: AriaRole;
  /**
   * Matched the way Playwright matches it, so that the fake and the real
   * browser agree on what a Locator means: whitespace-normalised, and by
   * default a case-insensitive substring. Absent means the role alone selects,
   * which is how an unnamed control is reached.
   */
  readonly name?: string;
  /** Match `name` as the whole accessible name rather than as a substring. */
  readonly exact?: boolean;
  /** Zero-based. Which of several matches to take. */
  readonly ordinal?: number;
  /** Search only inside this control. Nests to any depth. */
  readonly within?: Locator;
}

/**
 * One thing that can be done to a Surface. A single `perform` over a
 * discriminated union rather than six named methods, so that the policy gate
 * has exactly one place to stand and each decorator has one method to wrap.
 *
 * The verbs match the Recording's Step vocabulary and the discovery tool schema
 * exactly (ADR 0002), so that turning a Discovery Run into a Recording is a
 * filter over successful Actions rather than a translation.
 */
export type Action =
  | { readonly kind: "navigate"; readonly url: string }
  | { readonly kind: "click"; readonly locator: Locator }
  | { readonly kind: "fill"; readonly locator: Locator; readonly value: string }
  | { readonly kind: "select"; readonly locator: Locator; readonly option: string }
  | { readonly kind: "read"; readonly locator: Locator }
  | {
      readonly kind: "waitFor";
      readonly locator: Locator;
      /** Absent means the Surface's own default. */
      readonly timeoutMs?: number;
    };

/**
 * What performing one Action produced.
 *
 * A control that is missing or ambiguous is a returned value, not a thrown
 * error. ADR 0004 and ADR 0005 both push expected-but-negative states out of
 * `catch` blocks, and this is one: the executor needs the Locator in hand to
 * put in a failure report, and the discovery loop needs to read the miss and
 * try something else. Genuine breakage — a closed browser, an unreachable host
 * — still throws, because nothing sensible can be done with it here.
 *
 * `ambiguous` exists rather than quietly taking the first match. The
 * accessibility-tree survey found `link "Funds Transfer Sent"` four times in
 * one table; taking the first is how a Replay reads the wrong row and reports
 * success.
 */
export type ActionResult =
  | {
      readonly kind: "ok";
      /** The accessible name a `read` returned. Absent for every other Action. */
      readonly value?: string;
    }
  | { readonly kind: "not-found"; readonly locator: Locator }
  | { readonly kind: "ambiguous"; readonly locator: Locator; readonly matches: number };

/** What the Surface can see, in the one vocabulary ADR 0001 allows. */
export interface Snapshot {
  /** Where the screen is. The policy gate checks origin and path against this. */
  readonly url: string;
  /**
   * The accessibility tree as Playwright's snapshot YAML. This is the form a
   * model reads during a Discovery Run — indentation carries the structure, and
   * it is far cheaper in tokens than JSON.
   */
  readonly tree: string;
  /** The same tree parsed, which is what Locators and predicates match over. */
  readonly nodes: readonly AriaNode[];
}

/**
 * The Locator naming one option inside a control that offers several.
 *
 * Both Surfaces build it the same way, and both report it when the option is
 * not on offer. It lives here rather than being written out twice because the
 * two copies drifting apart is exactly how the browser and the fake would begin
 * failing differently without anyone noticing.
 */
export function optionLocator(control: Locator, option: string): Locator {
  return { role: "option", name: option, exact: true, within: control };
}
