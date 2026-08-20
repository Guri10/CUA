/**
 * What the person did, in the same vocabulary the Recording uses.
 *
 * The spec's user story is the whole justification: "I want what I did captured
 * in the same vocabulary the Recording uses, so that my manual fix can later be
 * folded into the Recording rather than re-derived." A video, or a list of
 * coordinates, or a diff of the URL would each say a person did something
 * without saying what — and the Step that a Recording would need is precisely
 * the thing that would then have to be worked out again by hand.
 *
 * So the capture produces `Action` values addressing role-plus-name Locators,
 * the same ones ADR 0001 makes the targeting contract, which is why this
 * bothers to derive an accessible name inside the page rather than recording
 * the element. There is no cheaper way: by the time a click event has been
 * handled the page may already be navigating, and the element is gone.
 *
 * It is split in two on purpose. `capturingScript` runs in the browser and can
 * be checked only against a real one, so it does as little judging as possible
 * — it reports the control's role, its accessible name, and which of several
 * identical controls it was. `actionFrom` runs here, is pure, and is where a
 * payload becomes an Action or is dropped; that half is unit tested, and the
 * end-to-end test replays the captured Locators back through `getByRole` to
 * say the two halves agree.
 *
 * **The name derivation is a simplification, and knowingly so.** The full
 * accessible-name algorithm is long, and most of its length is cases this
 * application does not contain. What is implemented is the part ParaBank needs:
 * `aria-label`, `aria-labelledby`, a `<label>` bound to a control, an input's
 * own button text, and otherwise the control's own text. A control it names
 * differently from Playwright yields a Locator that finds nothing on replay,
 * which is visible immediately rather than silently wrong — and the operator
 * reads the Steps before they are folded into anything.
 */
import { z } from "zod";
import { ARIA_ROLES, type AriaRole } from "./aria-roles.js";
import type { Action, Locator } from "./surface.js";

/**
 * What the page reports for one thing a person did.
 *
 * Validated rather than trusted, because it arrives from a script running in a
 * page this system does not own. A field the browser reports in a shape nobody
 * expected drops the Action instead of putting a malformed Locator into
 * evidence.
 */
export const capturedControlSchema = z.object({
  kind: z.enum(["click", "fill", "select"]),
  role: z.string(),
  /** Empty when the control has no accessible name, which ParaBank's inputs do not. */
  name: z.string(),
  /** How many visible controls share that role and name. */
  matches: z.number().int().min(1),
  /** Zero-based, which of them this was. */
  ordinal: z.number().int().min(0),
  /** What was typed, or the option chosen. Absent on a click. */
  value: z.string().optional(),
});

export type CapturedControl = z.infer<typeof capturedControlSchema>;

/**
 * Stops a capture that is running.
 *
 * Declared here rather than beside the escalation that calls it, because this
 * is the module the capture belongs to: `PlaywrightSurface` returns one and a
 * desktop Surface would return one too. A type whose implementors all live
 * somewhere else is a type in the wrong place.
 */
export type StopCapture = () => Promise<void>;

const KNOWN_ROLES = new Set<string>(ARIA_ROLES);

/**
 * One captured control, as an Action — or nothing, when it is not one this
 * system has a verb for.
 *
 * Dropping is the right answer for a role outside the vocabulary: the person
 * clicked a `<div>` that does nothing, or a role this codebase has no name for,
 * and inventing a Locator for it would put a Step into a Recording that could
 * never be replayed. The run still happened; it is the Step that does not
 * exist.
 */
export function actionFrom(captured: unknown): Action | undefined {
  const parsed = capturedControlSchema.safeParse(captured);
  if (!parsed.success) return undefined;

  const { kind, role, name, matches, ordinal, value } = parsed.data;
  if (!KNOWN_ROLES.has(role)) return undefined;

  const locator: Locator = {
    role: role as AriaRole,
    // An unnamed control is addressed by role alone, exactly as the login
    // inputs are — ADR 0001's note that ParaBank's have no accessible name is
    // the reason `name` is optional on a Locator at all.
    ...(name === "" ? {} : { name, exact: true }),
    // Carried only when it disambiguates. An ordinal on a Locator that already
    // picks out one control is noise in a diff, and it is the field most likely
    // to be wrong the next time the page renders a row more or fewer.
    ...(matches > 1 ? { ordinal } : {}),
  };

  if (kind === "click") return { kind: "click", locator };
  if (value === undefined) return undefined;
  return kind === "fill" ? { kind: "fill", locator, value } : { kind: "select", locator, option: value };
}

/**
 * The listeners, as a function to run inside the page.
 *
 * Written as one self-contained function because that is how it crosses into
 * the browser — nothing it refers to from this module would exist on the other
 * side. It is installed on every navigation, so it re-installs itself as the
 * person moves through the application, and guards on a flag so that installing
 * it twice on one document does not report every action twice.
 *
 * `change` rather than `input`, so that a name typed one letter at a time is
 * one Step and not eleven.
 */
export function capturingScript(): string {
  return String(installCapture);
}

/** The name the page calls to report. Bound on the Node side. */
export const CAPTURE_BINDING = "__cuaHumanAction";

/**
 * As much of the DOM as the injected script touches, declared here rather than
 * by turning on TypeScript's `DOM` library.
 *
 * Turning that library on would put `document` and `window` in scope for every
 * file in this project, including the ones that run in Node and would then
 * typecheck a reference to a browser global that does not exist at run time.
 * These declarations are module-scoped, so the browser half of this file is
 * typed and nothing else changes — and the list doubles as an exact statement
 * of what the script reaches for on a page this system does not own.
 */
interface DomElement {
  readonly tagName: string;
  readonly parentElement: DomElement | null;
  readonly textContent: string | null;
  /** On a form control: the `<label>` elements bound to it. */
  readonly labels?: ArrayLike<DomElement> | null;
  /** On a `<select>`. */
  readonly selectedOptions?: ArrayLike<DomElement>;
  readonly multiple?: boolean;
  readonly size?: number;
  readonly value?: string;
  getAttribute(name: string): string | null;
  hasAttribute(name: string): boolean;
  /** Empty when the control is not laid out, which is how visibility is judged. */
  getClientRects(): ArrayLike<unknown>;
}

interface DomDocument {
  getElementById(id: string): DomElement | null;
  getElementsByTagName(name: string): ArrayLike<DomElement>;
  addEventListener(
    type: string,
    listener: (event: { readonly target: unknown }) => void,
    capture: boolean,
  ): void;
}

declare const document: DomDocument;

/**
 * Runs in the browser. Nothing outside its own body is in scope there, which is
 * why the role and name derivation is written out inside it rather than shared
 * with anything here.
 */
function installCapture(binding: string): void {
  const page = globalThis as unknown as Record<string, unknown>;
  if (page[binding + "__installed"] === true) return;
  page[binding + "__installed"] = true;

  const report = page[binding] as ((captured: unknown) => void) | undefined;
  if (report === undefined) return;

  const text = (value: string | null | undefined): string =>
    (value ?? "").replace(/\s+/g, " ").trim();

  const roleOf = (element: DomElement): string => {
    const explicit = element.getAttribute("role");
    if (explicit !== null && explicit !== "") return explicit;

    const tag = element.tagName.toLowerCase();
    if (tag === "a") return element.hasAttribute("href") ? "link" : "";
    if (tag === "button") return "button";
    if (tag === "textarea") return "textbox";
    if (tag === "select") {
      return element.multiple === true || (element.size ?? 0) > 1 ? "listbox" : "combobox";
    }
    if (tag === "input") {
      const type = (element.getAttribute("type") ?? "text").toLowerCase();
      if (type === "submit" || type === "button" || type === "reset" || type === "image") {
        return "button";
      }
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      if (type === "search") return "searchbox";
      if (type === "hidden") return "";
      return "textbox";
    }
    return "";
  };

  /**
   * The roles whose accessible name comes from the text inside them.
   *
   * Not every role does, and the difference is load-bearing rather than
   * pedantic: a `<select>` with no label has *no* accessible name, and reading
   * its contents would name it after the run of every option it offers. A
   * Locator built from that finds nothing, which is how a capture produces
   * Steps that look right in a diff and are unreplayable.
   */
  const namedByContent = [
    "button", "link", "heading", "cell", "columnheader", "rowheader", "option",
    "menuitem", "menuitemcheckbox", "menuitemradio", "radio", "checkbox",
    "switch", "tab", "treeitem", "row", "gridcell", "tooltip",
  ];

  const nameOf = (element: DomElement, role: string): string => {
    const label = text(element.getAttribute("aria-label"));
    if (label !== "") return label;

    const labelledBy = element.getAttribute("aria-labelledby");
    if (labelledBy !== null) {
      const named = labelledBy
        .split(/\s+/)
        .map((id) => text(document.getElementById(id)?.textContent))
        .filter((part) => part !== "")
        .join(" ");
      if (named !== "") return named;
    }

    const labels = element.labels;
    if (labels !== undefined && labels !== null && labels.length > 0) {
      const named = text(
        Array.from(labels)
          .map((one) => one.textContent ?? "")
          .join(" "),
      );
      if (named !== "") return named;
    }

    const tag = element.tagName.toLowerCase();
    if (tag === "input") {
      const type = (element.getAttribute("type") ?? "text").toLowerCase();
      // A submit button's accessible name is the text on it, which for an
      // `<input>` is its value rather than its content.
      if (type === "submit" || type === "button" || type === "reset") {
        return text(element.getAttribute("value"));
      }
      if (type === "image") return text(element.getAttribute("alt"));
      // Everything else typed into is named by its label or by nothing at all.
      // What is in it is what the person put there, not what it is called —
      // ADR 0001's note that ParaBank's login inputs have no accessible name is
      // this branch, and it is why a Locator may carry a role and no name.
      return "";
    }

    if (namedByContent.indexOf(role) !== -1) {
      const own = text(element.textContent);
      if (own !== "") return own;
    }
    return text(element.getAttribute("title"));
  };

  /** The nearest ancestor that is a control, for a click landing on text inside one. */
  const controlAt = (start: unknown): DomElement | undefined => {
    const looksLikeElement = (value: unknown): value is DomElement =>
      value !== null && typeof value === "object" && typeof (value as DomElement).tagName === "string";

    let element = looksLikeElement(start) ? start : undefined;
    for (let depth = 0; element !== undefined && depth < 6; depth += 1) {
      if (roleOf(element) !== "") return element;
      element = element.parentElement ?? undefined;
    }
    return undefined;
  };

  const visible = (element: DomElement): boolean => element.getClientRects().length > 0;

  /**
   * Which of the controls sharing this role and name it was, and how many there
   * are. The ordinal is what makes a Locator addressing one of four identically
   * named links mean the row the person actually used — the accessibility-tree
   * survey found exactly that on ParaBank's activity table.
   */
  const positionOf = (element: DomElement, role: string, name: string): [number, number] => {
    let matches = 0;
    let ordinal = 0;
    for (const candidate of Array.from(document.getElementsByTagName("*"))) {
      if (roleOf(candidate) !== role) continue;
      if (nameOf(candidate, role) !== name) continue;
      if (!visible(candidate)) continue;
      if (candidate === element) ordinal = matches;
      matches += 1;
    }
    return [matches > 0 ? matches : 1, ordinal];
  };

  const send = (kind: string, element: DomElement, value?: string): void => {
    const role = roleOf(element);
    if (role === "") return;
    const name = nameOf(element, role);
    const [matches, ordinal] = positionOf(element, role, name);
    report({ kind, role, name, matches, ordinal, ...(value === undefined ? {} : { value }) });
  };

  // The capture phase, so that a control which stops the event from propagating
  // — which in an application of this age is most of the ones that matter — is
  // still seen.
  document.addEventListener(
    "click",
    (event) => {
      const control = controlAt(event.target);
      if (control !== undefined) send("click", control);
    },
    true,
  );

  // `change` rather than `input`, so that a name typed one letter at a time is
  // one Step and not eleven.
  document.addEventListener(
    "change",
    (event) => {
      const control = controlAt(event.target);
      if (control === undefined) return;

      if (control.tagName.toLowerCase() === "select") {
        const chosen = control.selectedOptions?.[0];
        // The label, not the value: a Recording addresses an option by the text
        // a person reads, because that is what survives a change of ids.
        send("select", control, text(chosen?.textContent ?? control.value ?? ""));
        return;
      }

      const type = (control.getAttribute("type") ?? "text").toLowerCase();
      // Ticking a box is a click in this vocabulary. There is no `check` verb,
      // and inventing one here would put a Step into a Recording that the
      // executor has no way to replay.
      if (type === "checkbox" || type === "radio") {
        send("click", control);
        return;
      }

      send("fill", control, control.value ?? "");
    },
    true,
  );
}
