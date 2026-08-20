/**
 * ADR 0006's classification for an Action and its result: which field carries
 * what kind of data, and therefore what may be written.
 *
 * It lives on its own because two things now log Actions. The evidence
 * decorator logs what the agent performed, and the escalation logs what the
 * person who took the session over did — and #11's audit requirement is that
 * both appear in one trail, told apart by who acted. Two copies of this switch
 * would be two classifications that agree until the day somebody adds a verb to
 * one of them, and the failure mode is a value written in full because the
 * second copy had never heard of the field it sat in.
 *
 * Classification happens here rather than in the log because only this layer
 * knows where a value sat: what a `read` returned is Sensitive by position, a
 * Locator's accessible name is Plain until this run's own input was substituted
 * into it, and what a `fill` typed may be the application password.
 */
import type { Action, ActionResult, Locator } from "../surface/surface.js";
import { redact, type Redaction } from "./redaction.js";

export function loggedAction(redaction: Redaction, action: Action): Record<string, unknown> {
  const plain = (text: string): string => redact(redaction, "plain", text);
  const sensitive = (text: string): string => redact(redaction, "sensitive", text);

  switch (action.kind) {
    case "navigate":
      return { kind: action.kind, url: plain(action.url) };
    case "fill":
      // What was typed. A password reaching here is a Secret and is stripped
      // whatever the setting says; anything else typed into an application like
      // this one is Sensitive.
      return {
        kind: action.kind,
        locator: loggedLocator(redaction, action.locator),
        value: sensitive(action.value),
      };
    case "select":
      return {
        kind: action.kind,
        locator: loggedLocator(redaction, action.locator),
        option: sensitive(action.option),
      };
    case "waitFor":
      return {
        kind: action.kind,
        locator: loggedLocator(redaction, action.locator),
        ...(action.timeoutMs === undefined ? {} : { timeoutMs: action.timeoutMs }),
      };
    // Named rather than defaulted, so that an Action verb added later cannot be
    // logged by a catch-all that has no idea what its fields carry. This switch
    // is where ADR 0006 classifies a value, and a new verb arriving unclassified
    // is exactly the leak the classification exists to stop.
    case "click":
    case "read":
      return { kind: action.kind, locator: loggedLocator(redaction, action.locator) };
  }
}

export function loggedResult(redaction: Redaction, result: ActionResult): Record<string, unknown> {
  switch (result.kind) {
    case "ok":
      // The one field on this path carrying a value off the screen, and the
      // reason the Capability exists. Masked here, returned in full above.
      return {
        kind: result.kind,
        ...(result.value === undefined
          ? {}
          : { value: redact(redaction, "sensitive", result.value) }),
      };
    case "not-found":
      return { kind: result.kind, locator: loggedLocator(redaction, result.locator) };
    case "ambiguous":
      return {
        kind: result.kind,
        locator: loggedLocator(redaction, result.locator),
        matches: result.matches,
      };
    case "refused":
      return { kind: result.kind, reason: redact(redaction, "plain", result.reason) };
  }
}

/**
 * A Locator's role and shape are Plain — they are the checked-in Recording,
 * readable in a diff. Its accessible name is Plain too right up until this run
 * substituted an account number into it, which is why the name goes through the
 * Plain path rather than round it: that path masks a known Sensitive value
 * found inside.
 */
function loggedLocator(redaction: Redaction, locator: Locator): Record<string, unknown> {
  return {
    role: locator.role,
    ...(locator.name === undefined ? {} : { name: redact(redaction, "plain", locator.name) }),
    ...(locator.exact === undefined ? {} : { exact: locator.exact }),
    ...(locator.ordinal === undefined ? {} : { ordinal: locator.ordinal }),
    ...(locator.within === undefined ? {} : { within: loggedLocator(redaction, locator.within) }),
  };
}
