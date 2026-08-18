/**
 * ParaBank carries its session token in the URL rather than in a cookie alone,
 * so it appears throughout a captured accessibility tree. ADR 0006 classes a
 * session token as a Secret: never written to evidence, with no flag to disable
 * it. This masks it on the way to disk.
 */
const SESSION_ID = /jsessionid=[A-Za-z0-9]+/gi;

export function redactSessionIds(text: string): string {
  return text.replace(SESSION_ID, "jsessionid=[REDACTED]");
}
