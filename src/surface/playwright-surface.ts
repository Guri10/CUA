/**
 * The Surface backed by a real browser.
 *
 * Playwright is transport and nothing more (ADR 0001). Every Locator — to read
 * or to act — is resolved against the one perceived accessibility tree (ADR
 * 0011), never through Playwright's role-based element counting, which counted a
 * legacy wrapper row the snapshot leaves nameless and so disagreed with the fake
 * Surface and the Checkpoints. Playwright's role query survives only as the way a
 * node already resolved in the tree is turned into a physical handle to click or
 * type — built from that node's own role/name/ordinal path (`locatorForNode`),
 * counted the way the tree counts, so a click lands on the node the resolver
 * chose and not on whatever a fresh role count would find. No CSS or XPath
 * expression appears here, and `no-css-or-xpath.test.ts` keeps it that way.
 *
 * It deliberately does not redact anything. ADR 0006 makes redaction a rule
 * about what is stored, never about what is observed, so the session token in a
 * ParaBank URL arrives here intact and is masked by the evidence decorator on
 * the way to disk.
 */
import { chromium, type Browser, type Locator as BrowserLocator, type Page } from "playwright";
import { readAriaSnapshot, type AriaNode } from "./aria-snapshot.js";
import {
  actionFrom,
  actionsFromSnapshot,
  injectableCaptureScript,
  snapshotExpression,
  CAPTURE_BINDING,
  type StopCapture,
} from "./human-actions.js";
import { locatorForNode } from "./locator-for-node.js";
import { readControlValue } from "./read-value.js";
import { resolveLocatorIndices, resolveLocatorIndicesWithin } from "./resolve-locator.js";
import { optionLocator, type Action, type ActionResult, type Locator, type Snapshot, type Surface } from "./surface.js";

export interface PlaywrightSurfaceOptions {
  /** How long to wait for a control before calling it absent. */
  readonly defaultTimeoutMs?: number;
  /**
   * Whether to hide the browser window. Escalation needs it shown: a human
   * taking over is meant to operate the very session the automation was using
   * rather than starting a fresh one, and they cannot operate a window that is
   * not on screen.
   */
  readonly headless?: boolean;
}

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * How often a Locator is re-resolved against a fresh perceived tree while waiting
 * for its control to arrive. Every MERIDIAN table and record cell fills after the
 * screen renders, so both a read and an action wait on the control appearing in
 * the tree rather than on the screen (ADR 0001); short enough to feel prompt, long
 * enough not to churn ariaSnapshot pointlessly.
 */
const RESOLVE_POLL_INTERVAL_MS = 200;

export class PlaywrightSurface implements Surface {
  readonly #page: Page;
  readonly #timeoutMs: number;
  /** Set only when this object launched the browser, and so must close it. */
  #owned: Browser | undefined;
  /** Whether the page listeners are installed. Once per page, not once per handover. */
  #capturing = false;
  /** Where a captured Action goes, and `undefined` whenever nobody is listening. */
  #onHumanAction: ((action: Action) => void) | undefined;

  /**
   * Takes a page rather than making one, so that a session already in progress
   * — one a human has been driving — can be wrapped and carried on with.
   */
  constructor(page: Page, options: PlaywrightSurfaceOptions = {}) {
    this.#page = page;
    this.#timeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  static async launch(options: PlaywrightSurfaceOptions = {}): Promise<PlaywrightSurface> {
    const browser = await chromium.launch({ headless: options.headless ?? true });
    const surface = new PlaywrightSurface(await browser.newPage(), options);
    surface.#owned = browser;
    return surface;
  }

  /**
   * Outside the `Surface` interface on purpose. Owning a browser is this
   * implementation's problem, and a fourth method would be a fourth method
   * every decorator has to forward correctly for no gain.
   */
  async close(): Promise<void> {
    await this.#owned?.close();
  }

  /**
   * Records what a person does to this page, as Actions.
   *
   * Outside the interface for the same reason `close` is: it is a property of
   * having a browser rather than of driving a screen. A desktop Surface would
   * implement the same idea over platform accessibility events, and neither
   * would want the three decorators forwarding a fourth method to reach it.
   *
   * The listeners go in through an init script so that they survive the person
   * navigating — which they will, because that is most of what taking over a
   * session involves — and are also run against the page already open, which
   * loaded before the script existed.
   *
   * Stopping is a switch on this side rather than a teardown on the page's. The
   * page will be navigated again by the run that resumes, and an init script
   * cannot be un-registered; what matters is that nothing is recorded once the
   * agent is driving again, and dropping the handler is the version of that
   * which cannot be defeated by a page reload.
   */
  async captureHumanActions(onAction: (action: Action) => void): Promise<StopCapture> {
    // Page-ready and transpiler-proof: `injectableCaptureScript` explains why
    // the serialised listeners have to be wrapped rather than injected raw.
    const install = injectableCaptureScript(CAPTURE_BINDING);

    if (!this.#capturing) {
      this.#capturing = true;
      await this.#page.exposeBinding(CAPTURE_BINDING, (_source, captured: unknown) => {
        // Validated on this side, and dropped rather than guessed at: the
        // payload comes from a script running in a page this system does not
        // own.
        const action = actionFrom(captured);
        if (action !== undefined) this.#onHumanAction?.(action);
      });
      await this.#page.addInitScript({ content: install });
    }

    this.#onHumanAction = onAction;
    await this.#install(install);

    return async () => {
      // Read the form's final state before dropping the handler, so an option
      // the person picked but left on its default — which fires no change event
      // and so was never captured live — is still recorded. Guarded: by the
      // time the session comes back the page may have navigated or closed, and a
      // snapshot that cannot be read is no controls rather than a failed stop.
      let finalState: readonly Action[] = [];
      try {
        const controls = await this.#page.evaluate(snapshotExpression(CAPTURE_BINDING));
        finalState = actionsFromSnapshot(controls);
      } catch {
        finalState = [];
      }
      this.#onHumanAction = undefined;
      return finalState;
    };
  }

  /**
   * Runs the listeners against the document that is already open.
   *
   * It can lose a race, and does. An escalation is raised at the moment a Step
   * was refused, which is very often the moment after a click — and a click
   * resolves before the navigation it started finishes, so the document this
   * evaluates against can be torn out from under it. The init script has
   * already been registered by then, so the document arriving next is covered
   * whatever happens here; what is at stake is only the one already on screen.
   *
   * So it waits for the page to settle and tries once more, and lets a second
   * failure through. Swallowing it would mean a handover that silently records
   * nothing until the person navigates, which is the kind of quiet gap an audit
   * trail must not have.
   */
  async #install(script: string): Promise<void> {
    try {
      await this.#page.evaluate(script);
    } catch {
      await this.#page.waitForLoadState();
      await this.#page.evaluate(script);
    }
  }

  async snapshot(): Promise<Snapshot> {
    const tree = await this.#page.ariaSnapshot();
    return { url: this.#page.url(), tree, nodes: readAriaSnapshot(tree) };
  }

  async perform(action: Action): Promise<ActionResult> {
    if (action.kind === "navigate") {
      await this.#page.goto(action.url);
      return { kind: "ok" };
    }

    // readEach takes one perception; every other Locator action resolves the same
    // way — against the one perceived tree (ADR 0011), waiting for the control to
    // arrive, then acting on the node it resolved via the node-to-handle mapping.
    if (action.kind === "readEach") return await this.#readEach(action);

    const timeoutMs =
      action.kind === "waitFor" ? (action.timeoutMs ?? this.#timeoutMs) : this.#timeoutMs;

    const resolved = await this.#resolve(action.locator, timeoutMs);
    if (resolved.kind !== "resolved") return resolved;
    const { nodes, index } = resolved;

    switch (action.kind) {
      case "waitFor":
        return { kind: "ok" };

      case "read":
        return { kind: "ok", value: readControlValue(nodes, index) };

      case "click":
        await this.#handleFor(nodes, index).click({ timeout: timeoutMs });
        return { kind: "ok" };

      case "fill":
        await this.#handleFor(nodes, index).fill(action.value, { timeout: timeoutMs });
        return { kind: "ok" };

      case "select":
        return await this.#select(action.locator, this.#handleFor(nodes, index), action.option, timeoutMs);
    }
  }

  async screenshot(): Promise<Buffer> {
    return await this.#page.screenshot();
  }

  /**
   * Resolves a Locator against the one perceived tree, waiting for its control to
   * arrive, and reports which node it landed on — or the same miss the fake
   * Surface reports, so an interaction resolves identically offline and live.
   *
   * The wait has to come first, and it is a wait on the tree: every table here
   * fills from a request that finishes after the screen does, so it re-snapshots
   * until the Locator resolves or the timeout lapses rather than calling a
   * not-yet-rendered control absent. Exactly one match is the node to act on;
   * none by the deadline is `not-found`; more than one is `ambiguous` — a miss a
   * Terminal State can catch (this is how `MULTIPLE_MATCHES` is reached) and,
   * where no outcome claims it, the Hard Failure Replay raises naming the Step.
   * Never a silent pick of the first.
   *
   * Only what the accessibility tree carries is counted, so a control in a hidden
   * region — which the tree never reaches — cannot make a Locator read ambiguous
   * live while the fake, reading the same tree, calls it unique.
   */
  async #resolve(
    locator: Locator,
    timeoutMs: number,
  ): Promise<
    | { readonly kind: "resolved"; readonly nodes: readonly AriaNode[]; readonly index: number }
    | { readonly kind: "not-found"; readonly locator: Locator }
    | { readonly kind: "ambiguous"; readonly locator: Locator; readonly matches: number }
  > {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const { nodes } = await this.snapshot();
      const matches = resolveLocatorIndices(nodes, locator);
      if (matches.length === 1) return { kind: "resolved", nodes, index: matches[0]! };
      if (matches.length > 1) return { kind: "ambiguous", locator, matches: matches.length };
      if (Date.now() >= deadline) return { kind: "not-found", locator };
      await this.#page.waitForTimeout(RESOLVE_POLL_INTERVAL_MS);
    }
  }

  /**
   * The live handle for a node the resolver landed on: its own role/name/ordinal
   * path (`locatorForNode`) built as a Playwright role query — counted the way the
   * tree counts, never re-found by a fresh role count, which is what re-imports
   * the wrapper divergence ADR 0011 removes. This is the one place a resolved node
   * becomes something to physically click or type, and it stays inside ADR 0001's
   * vocabulary: a role, an accessible name, an ordinal — no CSS, no XPath.
   *
   * A uniquely-named path carries no ordinal, and deliberately gets no `.first()`:
   * `#resolve` already proved the tree holds exactly one such node, so if the live
   * role query nonetheless matches several, that is a real divergence between the
   * two lenses and Playwright's strict mode throws — the loud failure ADR 0011
   * wants, never the silent pick-the-first the old acting path made.
   */
  #handleFor(nodes: readonly AriaNode[], index: number): BrowserLocator {
    const path = locatorForNode(nodes, index);
    const byRole = this.#page.getByRole(path.role, {
      ...(path.name === undefined ? {} : { name: path.name }),
      ...(path.exact === undefined ? {} : { exact: path.exact }),
    });
    return path.ordinal === undefined ? byRole : byRole.nth(path.ordinal);
  }

  async #select(
    locator: Locator,
    handle: BrowserLocator,
    option: string,
    timeoutMs: number,
  ): Promise<ActionResult> {
    try {
      await handle.selectOption({ label: option }, { timeout: timeoutMs });
      return { kind: "ok" };
    } catch {
      // An option the control does not offer, reported as the Locator that
      // would have named it — the same result the scripted fake produces, so
      // an interaction fails identically on both.
      return { kind: "not-found", locator: optionLocator(locator, option) };
    }
  }

  /**
   * Read each matching row into a record of its columns — `readEach`, resolved
   * against the one perceived tree by the very functions the fake Surface uses,
   * so list reads and single reads cannot drift onto different lenses (ADR 0011).
   *
   * Each column is resolved *inside* its row, so a field can only come from that
   * row. A column matching none or several of a row's controls is the same miss
   * any read would be, reported against the column's Locator. Unlike a single
   * read it takes one perception and does not poll: no matching rows is an empty
   * list, which is a value (ADR 0010) — a table present but with no data rows,
   * not a control to keep waiting on — so the wait for a late-filling table
   * belongs to a `waitFor` Step before this, never to a self-poll that would turn
   * an empty table into a timeout.
   */
  async #readEach(action: Extract<Action, { kind: "readEach" }>): Promise<ActionResult> {
    const { nodes } = await this.snapshot();

    const records: Record<string, string>[] = [];
    for (const row of resolveLocatorIndices(nodes, action.rows)) {
      const record: Record<string, string> = {};
      for (const [field, column] of Object.entries(action.columns)) {
        const cells = resolveLocatorIndicesWithin(nodes, column, row);
        if (cells.length === 0) return { kind: "not-found", locator: column };
        if (cells.length > 1) return { kind: "ambiguous", locator: column, matches: cells.length };
        record[field] = readControlValue(nodes, cells[0]!);
      }
      records.push(record);
    }
    return { kind: "ok", records };
  }
}
