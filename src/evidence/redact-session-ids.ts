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
 * Two things keep this from either leaking or corrupting. It is anchored at a
 * word boundary and matched only ahead of a token that *contains a digit*, so
 * the prose word `SID` — as in a ParaBank error `unknown SID field`, which this
 * same always-on pass runs over — is never eaten, while a real high-entropy
 * token always is. And it does not pin to one rendering: the separator may be a
 * space, colon, or `=` (with any surrounding whitespace), the marker is matched
 * case-insensitively so a lowercase `sid=` URL param is caught, and the token
 * runs over `-` and `_` so a hyphenated or base64url id is masked whole rather
 * than up to its first punctuation.
 */
const MERIDIAN_SID = /\b(SID[ :=]\s*)(?=[A-Za-z0-9_-]*[0-9])[A-Za-z0-9_-]{4,}/gi;

export function redactMeridianSessionId(text: string): string {
  return text.replace(MERIDIAN_SID, "$1[REDACTED]");
}

export function redactSessionIds(text: string): string {
  return redactMeridianSessionId(text.replace(SESSION_ID, "jsessionid=[REDACTED]"));
}
