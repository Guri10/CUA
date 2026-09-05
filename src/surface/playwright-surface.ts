/**
 * The Surface backed by a real browser.
 *
 * Playwright is transport and nothing more (ADR 0001). It executes Locators
 * through its role-based query API; no CSS or XPath expression appears here,
 * and `no-css-or-xpath.test.ts` keeps it that way. Every method below is a
 * translation from the accessibility vocabulary into whatever Playwright calls
 * the same idea, which is exactly the layer a desktop Surface would replace.
 *
 * It deliberately does not redact anything. ADR 0006 makes redaction a rule
 * about what is stored, never about what is observed, so the session token in a
 * ParaBank URL arrives here intact and is masked by the evidence decorator on
 * the way to disk.
 */
import { chromium, type Browser, type Locator as BrowserLocator, type Page } from "playwright";
import { readAriaSnapshot } from "./aria-snapshot.js";
import { actionFrom, injectableCaptureScript, CAPTURE_BINDING, type StopCapture } from "./human-actions.js";
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
 * How often a read re-snapshots while waiting for its value to arrive. Every
 * MERIDIAN table and record cell fills after the screen renders, so a read waits
 * on the value rather than the screen (ADR 0001); short enough to feel prompt,
 * long enough not to churn ariaSnapshot pointlessly.
 */
const READ_POLL_INTERVAL_MS = 200;

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
      this.#onHumanAction = undefined;
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

    // Reads resolve against the one perceived tree, not through getByRole (ADR
    // 0011): the role-based lens counts a legacy wrapper row the snapshot leaves
    // nameless, landing a read on a label cell. Acting still resolves through
    // getByRole for now — named controls do not diverge.
    if (action.kind === "readEach") return await this.#readEach(action);
    if (action.kind === "read") return await this.#read(action);

    const control = this.#locate(action.locator);
    const timeoutMs =
      action.kind === "waitFor" ? (action.timeoutMs ?? this.#timeoutMs) : this.#timeoutMs;

    const resolved = await this.#resolveToOne(action.locator, control, timeoutMs);
    if (resolved.kind !== "ok") return resolved;

    const one = control.first();
    switch (action.kind) {
      case "waitFor":
        return { kind: "ok" };

      case "click":
        await one.click({ timeout: timeoutMs });
        return { kind: "ok" };

      case "fill":
        await one.fill(action.value, { timeout: timeoutMs });
        return { kind: "ok" };

      case "select":
        return await this.#select(action.locator, one, action.option, timeoutMs);
    }
  }

  async screenshot(): Promise<Buffer> {
    return await this.#page.screenshot();
  }

  /**
   * Waits for the control to appear, then decides whether the Locator actually
   * picked exactly one out.
   *
   * The wait has to come first. Counting straight away would call a control
   * absent whenever it simply had not rendered yet, which in this application
   * is most of them — every table here fills from a request that finishes after
   * the screen does.
   *
   * Only visible matches are counted, because only visible ones were waited
   * for. Counting every attached match would report a control duplicated in
   * some hidden region as ambiguous in the browser while the fake, which reads
   * an accessibility tree that hidden elements never reach, called the same
   * Locator unambiguous.
   */
  async #resolveToOne(
    locator: Locator,
    control: BrowserLocator,
    timeoutMs: number,
  ): Promise<ActionResult> {
    try {
      await control.first().waitFor({ state: "visible", timeout: timeoutMs });
    } catch {
      return { kind: "not-found", locator };
    }

    const matches = await control.filter({ visible: true }).count();
    if (locator.ordinal === undefined && matches > 1) {
      return { kind: "ambiguous", locator, matches };
    }
    return { kind: "ok" };
  }

  async #select(
    locator: Locator,
    control: BrowserLocator,
    option: string,
    timeoutMs: number,
  ): Promise<ActionResult> {
    try {
      await control.selectOption({ label: option }, { timeout: timeoutMs });
      return { kind: "ok" };
    } catch {
      // An option the control does not offer, reported as the Locator that
      // would have named it — the same result the scripted fake produces, so
      // an interaction fails identically on both.
      return { kind: "not-found", locator: optionLocator(locator, option) };
    }
  }

  /**
   * Reads one control's value from the one perceived tree (ADR 0011), by the
   * same resolver and value rule the fake Surface and Checkpoint matching use —
   * so a read means the same thing offline and live. Nothing is read through
   * getByRole or the DOM: the value comes from the resolved node, which is what
   * lets this survive the move to a Surface with no DOM at all.
   *
   * It waits for the perceived tree to settle, not the screen: every MERIDIAN
   * record cell and table fills after the screen renders (ADR 0001), so it
   * re-snapshots until the Locator resolves or the timeout lapses. Once the node
   * resolves it returns whatever that node holds — a blank resolved cell is a
   * value, the same one the fake would return, so it is never waited out; a field
   * that fills late is waited for by a `waitFor` Step before this read. A Locator
   * that never resolves is `not-found`; more than one match is `ambiguous`, the
   * same miss any single read reports — never a silent wrong pick.
   */
  async #read(action: Extract<Action, { kind: "read" }>): Promise<ActionResult> {
    const deadline = Date.now() + this.#timeoutMs;
    for (;;) {
      const { nodes } = await this.snapshot();
      const matches = resolveLocatorIndices(nodes, action.locator);
      if (matches.length === 1) return { kind: "ok", value: readControlValue(nodes, matches[0]!) };
      if (matches.length > 1) {
        return { kind: "ambiguous", locator: action.locator, matches: matches.length };
      }
      if (Date.now() >= deadline) return { kind: "not-found", locator: action.locator };
      await this.#page.waitForTimeout(READ_POLL_INTERVAL_MS);
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

  /**
   * A Locator, in Playwright's vocabulary. Scoping recurses, so a parent that
   * matches several controls is searched in all of them — the rule the scripted
   * fake follows too. `base` is the scope to resolve in, the page unless a
   * `readEach` is reading a column inside one particular row.
   */
  #locate(locator: Locator, base: Page | BrowserLocator = this.#page): BrowserLocator {
    const scope = locator.within === undefined ? base : this.#locate(locator.within, base);
    const found = scope.getByRole(locator.role, {
      ...(locator.name === undefined ? {} : { name: locator.name }),
      ...(locator.exact === undefined ? {} : { exact: locator.exact }),
    });
    return locator.ordinal === undefined ? found : found.nth(locator.ordinal);
  }
}
