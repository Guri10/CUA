/**
 * A Surface with no browser behind it, answering the same three questions from
 * a scripted state machine.
 *
 * This is not a test convenience. `Surface` claims that driving an application
 * decomposes into "what is on the screen", "do one thing", and "show me" — and
 * a second implementation that satisfies the interface without a DOM is what
 * makes that claim checkable rather than asserted. It is the same argument for
 * a desktop Surface reading platform accessibility APIs: if the abstraction
 * survives having no browser at all, a different kind of screen is a smaller
 * step than a different kind of interface.
 *
 * Locators are resolved against the scripted tree by the same rules the browser
 * uses, so a Locator that is ambiguous here is ambiguous there. The screens can
 * therefore be real captured accessibility trees rather than invented ones, and
 * for ParaBank they are.
 */
import { readAriaSnapshot, type AriaNode } from "./aria-snapshot.js";
import { readControlValue } from "./read-value.js";
import { resolveLocatorIndices } from "./resolve-locator.js";
import { optionLocator, type Action, type ActionResult, type Locator, type Snapshot, type Surface } from "./surface.js";

export interface Script {
  readonly screens: readonly ScriptedScreen[];
}

export interface ScriptedScreen {
  readonly name: string;
  readonly url: string;
  /** The accessibility tree, in the snapshot YAML Playwright produces. */
  readonly tree: string;
  readonly transitions?: readonly ScriptedTransition[];
}

/** What one Action does to the screen the run is on. */
export interface ScriptedTransition {
  readonly when: ActionPattern;
  /** The `name` of the screen to move to. */
  readonly to: string;
}

/**
 * An Action matched structurally. A transition fires on which control was
 * acted on, not on what was typed into it — a login screen advances when the
 * button is clicked, whatever password was in the box.
 */
export type ActionPattern =
  | { readonly kind: "navigate"; readonly url: string }
  | { readonly kind: "click"; readonly locator: Locator }
  | { readonly kind: "fill"; readonly locator: Locator }
  | { readonly kind: "select"; readonly locator: Locator };

/**
 * A transition fires on the kind of Action and the Locator it addressed, both
 * compared structurally. Requiring the script to repeat the Locator verbatim is
 * deliberate: a transition that fired on "something like this" would let the
 * fake pass an interaction the browser would refuse.
 */
function matchesPattern(pattern: ActionPattern, action: Action): boolean {
  if (pattern.kind !== action.kind) return false;
  if (pattern.kind === "navigate") return true;
  return "locator" in action && sameLocator(pattern.locator, action.locator);
}

function sameLocator(left: Locator, right: Locator): boolean {
  return (
    left.role === right.role &&
    left.name === right.name &&
    left.exact === right.exact &&
    left.ordinal === right.ordinal &&
    (left.within === undefined || right.within === undefined
      ? left.within === right.within
      : sameLocator(left.within, right.within))
  );
}

const BLANK: ScriptedScreen = { name: "blank", url: "about:blank", tree: "" };

export class FakeSurface implements Surface {
  readonly #screens: ReadonlyMap<string, ScriptedScreen>;
  #current!: ScriptedScreen;
  #nodes!: readonly AriaNode[];
  /**
   * What has been typed into, or chosen in, each control on the current screen,
   * keyed by its position in the tree. Cleared on navigation, because a browser
   * loading a page loses whatever was in its boxes.
   */
  #entered = new Map<number, string>();

  constructor(script: Script) {
    this.#screens = new Map(script.screens.map((screen) => [screen.name, screen]));
    // Every run starts on a blank screen, so an interaction has to navigate to
    // get anywhere — the same thing the real browser makes it do.
    this.#goTo(BLANK);
  }

  async snapshot(): Promise<Snapshot> {
    return { url: this.#current.url, tree: this.#current.tree, nodes: this.#nodes };
  }

  async perform(action: Action): Promise<ActionResult> {
    if (action.kind === "navigate") {
      this.#goTo(this.#screenAt(action.url));
      return { kind: "ok" };
    }

    const matches = resolveLocatorIndices(this.#nodes, action.locator);
    if (matches.length === 0) return { kind: "not-found", locator: action.locator };
    if (matches.length > 1) {
      return { kind: "ambiguous", locator: action.locator, matches: matches.length };
    }
    const target = matches[0]!;

    switch (action.kind) {
      case "read":
        return { kind: "ok", value: this.#valueAt(target) };

      case "fill":
        this.#entered.set(target, action.value);
        break;

      case "select": {
        // A browser refuses an option the control does not offer, so the fake
        // has to as well — a fake that accepts interactions the real Surface
        // rejects is worse than no fake. Asking for the option as a Locator
        // scoped by the control both performs the check and produces the thing
        // a failure report needs to name.
        const option = optionLocator(action.locator, action.option);
        if (resolveLocatorIndices(this.#nodes, option).length === 0) {
          return { kind: "not-found", locator: option };
        }
        this.#entered.set(target, action.option);
        break;
      }

      case "click":
        break;

      case "waitFor":
        // Resolving was the wait. The fake has no clock, so a control that is
        // in the scripted tree is there immediately and one that is not never
        // arrives — which is the honest reading of a scripted screen.
        return { kind: "ok" };
    }

    this.#follow(action);
    return { kind: "ok" };
  }

  /**
   * Deterministic, and deliberately not a PNG. Evidence from a fake run should
   * be obviously a fake's, so nobody mistakes it for a picture of a browser.
   */
  async screenshot(): Promise<Buffer> {
    return Buffer.from(`fake screenshot: ${this.#current.name} at ${this.#current.url}\n`, "utf8");
  }

  /**
   * What a read gets back: what this run put into the control, or failing that
   * whatever the scripted tree says it already holds — by the same rule the
   * browser answers a read with.
   */
  #valueAt(index: number): string {
    return this.#entered.get(index) ?? readControlValue(this.#nodes, index);
  }

  #goTo(screen: ScriptedScreen): void {
    this.#current = screen;
    this.#nodes = readAriaSnapshot(screen.tree);
    this.#entered.clear();
  }

  /** Moves to whichever screen this Action was scripted to lead to, if any. */
  #follow(action: Action): void {
    const transition = this.#current.transitions?.find((candidate) =>
      matchesPattern(candidate.when, action),
    );
    if (transition !== undefined) this.#goTo(this.#screen(transition.to));
  }

  #screen(name: string): ScriptedScreen {
    const screen = this.#screens.get(name);
    if (screen === undefined) {
      throw new Error(`FakeSurface: no screen named "${name}" in the script.`);
    }
    return screen;
  }

  /**
   * An address the script does not describe is a mistake in the script rather
   * than a state of the application, so it throws instead of returning a result
   * a caller might treat as a legitimate dead end.
   */
  #screenAt(url: string): ScriptedScreen {
    const screen = [...this.#screens.values()].find((candidate) => candidate.url === url);
    if (screen === undefined) throw new Error(`FakeSurface: nothing scripted at ${url}`);
    return screen;
  }
}
