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
import { readControlValue } from "./read-value.js";
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

export class PlaywrightSurface implements Surface {
  readonly #page: Page;
  readonly #timeoutMs: number;
  /** Set only when this object launched the browser, and so must close it. */
  #owned: Browser | undefined;

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

  async snapshot(): Promise<Snapshot> {
    const tree = await this.#page.ariaSnapshot();
    return { url: this.#page.url(), tree, nodes: readAriaSnapshot(tree) };
  }

  async perform(action: Action): Promise<ActionResult> {
    if (action.kind === "navigate") {
      await this.#page.goto(action.url);
      return { kind: "ok" };
    }

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

      case "read":
        return { kind: "ok", value: await this.#read(one) };
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
   * Reads the control's own accessibility tree and answers from that, by the
   * same rule the fake answers with. Nothing is read through the DOM: a value
   * fetched from an input element would be the one thing here that a Surface
   * driving a desktop application could not do.
   */
  async #read(control: BrowserLocator): Promise<string> {
    return readControlValue(readAriaSnapshot(await control.ariaSnapshot()), 0);
  }

  /**
   * A Locator, in Playwright's vocabulary. Scoping recurses, so a parent that
   * matches several controls is searched in all of them — the rule the scripted
   * fake follows too.
   */
  #locate(locator: Locator): BrowserLocator {
    const scope = locator.within === undefined ? this.#page : this.#locate(locator.within);
    const found = scope.getByRole(locator.role, {
      ...(locator.name === undefined ? {} : { name: locator.name }),
      ...(locator.exact === undefined ? {} : { exact: locator.exact }),
    });
    return locator.ordinal === undefined ? found : found.nth(locator.ordinal);
  }
}
