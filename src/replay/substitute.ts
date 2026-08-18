/**
 * Filling a Recording's blanks in with the values one run was given.
 *
 * A Recording stores an Expression wherever a concrete value would otherwise
 * sit, which is what lets one Recording serve any account rather than the one
 * it was recorded against. This is the other half of that: turning the stored
 * form back into the `Locator` and `Action` the Surface actually takes.
 *
 * It is a pure function over data, so it is tested without a Surface at all.
 */
import type { Expression, StepAction, StepLocator } from "../capability/schema.js";
import type { Action, Locator } from "../surface/surface.js";

/** The values one run was given, already validated against the Contract. */
export type ReplayInputs = Readonly<Record<string, unknown>>;

/**
 * One Expression as text.
 *
 * Text rather than the declared type, because everything an Expression feeds
 * is text: an accessible name, what gets typed into a box, the option chosen
 * in a control. A Contract that declares a number still addresses a link whose
 * name is digits.
 */
export function substituteExpression(expression: Expression, inputs: ReplayInputs): string {
  if (expression.kind === "literal") return expression.value;

  const value = inputs[expression.input];
  if (value === undefined) {
    // The Contract is validated before the run starts, so an input that is
    // missing here is one the Capability declares as optional and the caller
    // left out — a Recording that cannot be filled in, not a state of the
    // application.
    throw new Error(
      `This run has no value for input "${expression.input}", which a Step refers to.`,
    );
  }
  return String(value);
}

export function substituteLocator(locator: StepLocator, inputs: ReplayInputs): Locator {
  // Built key by key rather than spread-and-overwrite: `exactOptionalPropertyTypes`
  // means an absent field and a field set to `undefined` are different types,
  // and the fake Surface compares Locators structurally.
  return {
    role: locator.role,
    ...(locator.name === undefined ? {} : { name: substituteExpression(locator.name, inputs) }),
    ...(locator.exact === undefined ? {} : { exact: locator.exact }),
    ...(locator.ordinal === undefined ? {} : { ordinal: locator.ordinal }),
    ...(locator.within === undefined ? {} : { within: substituteLocator(locator.within, inputs) }),
  };
}

/**
 * One Step's action as the Action the Surface takes.
 *
 * `baseUrl` is where the Surface profile of ticket 7 will eventually come in.
 * Until then the caller supplies the origin, and the important part is already
 * true: the Recording does not carry one.
 */
export function substituteAction(
  action: StepAction,
  inputs: ReplayInputs,
  baseUrl: string,
): Action {
  switch (action.kind) {
    case "navigate":
      return { kind: "navigate", url: absoluteUrl(substituteExpression(action.url, inputs), baseUrl) };

    case "click":
      return { kind: "click", locator: substituteLocator(action.locator, inputs) };

    case "fill":
      return {
        kind: "fill",
        locator: substituteLocator(action.locator, inputs),
        value: substituteExpression(action.value, inputs),
      };

    case "select":
      return {
        kind: "select",
        locator: substituteLocator(action.locator, inputs),
        option: substituteExpression(action.option, inputs),
      };

    case "read":
      // `bind` names the Contract output this value becomes, which is the
      // executor's business and not the Surface's.
      return { kind: "read", locator: substituteLocator(action.locator, inputs) };

    case "waitFor":
      return {
        kind: "waitFor",
        locator: substituteLocator(action.locator, inputs),
        ...(action.timeoutMs === undefined ? {} : { timeoutMs: action.timeoutMs }),
      };
  }
}

/**
 * The origin belongs to the Surface, the path to the Recording. A Recording
 * that had recorded a whole URL would run against exactly one installation, so
 * this refuses rather than quietly stripping the origin off and hoping.
 */
function absoluteUrl(path: string, baseUrl: string): string {
  if (!path.startsWith("/")) {
    throw new Error(
      `A navigate Step stores a path beginning with "/", not "${path}" — the origin belongs to the Surface profile.`,
    );
  }
  return `${baseUrl.replace(/\/+$/, "")}${path}`;
}
