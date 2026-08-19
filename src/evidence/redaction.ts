/**
 * ADR 0006's three data kinds, as pure functions applied at the boundary where
 * evidence is written rather than at the value itself.
 *
 * The distinction the ADR draws is between what we *store* and what we
 * *return*: reading the balance is the entire point of the lookup Capability,
 * so masking it in the caller's result would defeat the feature. Nothing here
 * ever touches a return value — every caller of `redact` is on a path to disk.
 *
 * The kinds are told apart two ways, because neither alone is enough. A field's
 * position says what it is — what a `read` returned is Sensitive wherever it
 * came from — and that is what `redact(…, "sensitive", …)` expresses. But a
 * value can also turn up inside a field that is Plain by position: an account
 * number substituted into a Locator's accessible name is one, and a Secret
 * appearing anywhere at all is the other. So known values are also matched by
 * value, and Secrets are stripped from every kind including Plain. A rule that
 * only classified positions would leak the first time a value moved.
 */
import { redactSessionIds } from "./redact-session-ids.js";

/** Written in place of a Secret. Matches what `redactSessionIds` already uses. */
export const SECRET_MARK = "[REDACTED]";
/** Written in place of a Sensitive value, and deliberately a different word. */
export const SENSITIVE_MARK = "[SENSITIVE]";

/**
 * Which of ADR 0006's three kinds a value is, by where it sits in the record
 * being written.
 */
export type DataKind = "secret" | "sensitive" | "plain";

export interface Redaction {
  /**
   * Values never written under any setting — the application password, handed
   * in at run time. There is no flag below that reaches these.
   */
  readonly secrets: readonly string[];
  /**
   * Values this run knows to be Sensitive before it starts: its own inputs,
   * which are substituted into Locators and so appear in fields that are
   * otherwise Plain. What a `read` returns is Sensitive too, but is not known
   * in advance, so it is classified by position instead.
   */
  readonly sensitive: readonly string[];
  /** On by default, and the only thing `--evidence-redaction` moves. */
  readonly masking: "on" | "off";
}

export function redact(redaction: Redaction, kind: DataKind, text: string): string {
  switch (kind) {
    case "secret":
      return SECRET_MARK;
    case "sensitive": {
      // Still stripped when masking is off: the flag makes a balance readable,
      // it does not make a password writable.
      const stripped = stripSecrets(redaction, text);
      // A value that turned out to be nothing but a Secret is reported as one,
      // whichever setting is in force. Otherwise the password typed into a
      // login form would read `[SENSITIVE]` with masking on and `[REDACTED]`
      // with it off, and the log would appear to say the flag moved it.
      if (stripped === SECRET_MARK) return SECRET_MARK;
      return redaction.masking === "on" ? SENSITIVE_MARK : stripped;
    }
    case "plain":
      return maskKnownSensitive(redaction, stripSecrets(redaction, text));
  }
}

/**
 * The unconditional pass. Every line goes through this on its way to disk,
 * after its fields have been classified, so that a Secret which reached a field
 * nobody thought about is still not written.
 */
export function stripSecrets(redaction: Redaction, text: string): string {
  // A Secret is matched anywhere, including glued to other characters. It is
  // the one kind with no acceptable failure mode, so the coarser rule is the
  // right one: writing part of a password is writing a password.
  const stripped = redaction.secrets.reduce(
    (carry, secret) => (secret === "" ? carry : carry.replaceAll(secret, SECRET_MARK)),
    text,
  );

  return redactSessionIds(stripped);
}

/**
 * This run's own inputs, wherever they were substituted in.
 *
 * Matched as a whole run of letters and digits rather than as any substring,
 * which is what an input actually is: a Step stores an Expression, and an
 * Expression is a literal or a whole reference — there is no concatenation, so
 * a substituted account number is the entire accessible name and never part of
 * one. The coarser rule would corrupt the log rather than protect anything:
 * with `accountId=8`, replacing every "8" turns `localhost:8080` into
 * `localhost:[SENSITIVE]0[SENSITIVE]0` and the line stops being machine-
 * readable, having hidden nothing that was not already public.
 */
function maskKnownSensitive(redaction: Redaction, text: string): string {
  if (redaction.masking === "off") return text;

  return redaction.sensitive.reduce(
    (carry, value) => (value === "" ? carry : carry.replace(wholeToken(value), SENSITIVE_MARK)),
    text,
  );
}

/** The value itself, not read as a pattern, and not glued to a longer token. */
function wholeToken(value: string): RegExp {
  const literal = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![A-Za-z0-9])${literal}(?![A-Za-z0-9])`, "g");
}
