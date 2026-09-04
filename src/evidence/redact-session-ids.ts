/**
 * A session token is a Secret under ADR 0006: never written to evidence, with no
 * flag to disable it. Both surfaces we drive carry that token somewhere the
 * captured accessibility tree will show it, so this is the one always-on pass
 * that strips it — `stripSecrets` runs every line to disk through here.
 *
 * ParaBank puts its token in the URL (`jsessionid=…`), so it appears throughout
 * a tree. MERIDIAN puts its token in the operator banner row (`SID 562CADE2`)
 * and uses clean paths, so it appears there instead. One entry point knows both
 * shapes, so a value that moves between fields is still masked.
 */
const SESSION_ID = /jsessionid=[A-Za-z0-9]+/gi;

/**
 * MERIDIAN's session token, as rendered in the operator banner (`SID 562CADE2`)
 * or, defensively, as a URL query parameter (`sid=…`). The `SID` marker plus a
 * separator introduces it, and the marker-and-separator is kept so the masked
 * line still reads as it did.
 *
 * The token is a Secret whatever random string it happens to be, so redaction
 * must not turn on the token's *contents* — an all-letter token has to be
 * masked exactly like a hex one (#32). But this same always-on pass runs over
 * every line to disk, including prose that merely says `SID`, as in a ParaBank
 * error `unknown SID field` — which must survive intact. What actually tells a
 * token introduction from prose is the *separator*, so this matches in two
 * shapes:
 *
 *   - Punctuation separator (`:` or `=`, with any whitespace on either side,
 *     which also covers `SID = …` where the space sits before the separator,
 *     #33). A colon or equals after `SID` is a strong "here is a value" signal
 *     that prose does not carry, so any id-charset run of 4+ is masked.
 *   - Bare space separator (`SID 562CADE2`, the banner form). A space alone is
 *     weak — it is also how `SID field` reads — so here the run must be id
 *     *shaped*: 8+ chars, the length MERIDIAN mints. That masks a high-entropy
 *     token whether or not it holds a digit, while a short prose word like
 *     `field` falls under the bar.
 *
 * Both shapes are anchored at a word boundary (so `SIDEBAR` and the `sid` in
 * `inside` are untouched), match the marker case-insensitively (so a lowercase
 * `sid=` URL param is caught), and run the token over `-` and `_` so a
 * hyphenated or base64url id is masked whole rather than up to its first
 * punctuation. The captured marker-and-separator is put back, so an
 * already-masked `SID [REDACTED]` — whose `[` is not an id char — matches
 * neither shape and the pass stays idempotent.
 */
const MERIDIAN_SID = /\b(SID\s*[:=]\s*)[A-Za-z0-9_-]{4,}|\b(SID +)[A-Za-z0-9_-]{8,}/gi;

export function redactMeridianSessionId(text: string): string {
  return text.replace(
    MERIDIAN_SID,
    (_match: string, punctuated: string, spaced: string) => `${punctuated ?? spaced}[REDACTED]`,
  );
}

export function redactSessionIds(text: string): string {
  return redactMeridianSessionId(text.replace(SESSION_ID, "jsessionid=[REDACTED]"));
}
