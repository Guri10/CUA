/**
 * The in-memory store that holds an Operator's password, keyed by the
 * non-secret operator id (#39 B, #42).
 *
 * The password is an ADR 0006 Secret: it lives only in this process's memory —
 * never in the repo, a command-line argument, the chatbot/API payload, or
 * evidence. Nothing here writes a password to disk or a log; the store is a plain
 * `Map` that the process drops when it exits. The portal (#44) and the hidden
 * command-line prompt (#45) are the two things that put a password in; session
 * establishment (`session.ts`) is what reads it back out, looked up by the
 * operator id the caller signs on as.
 */
export class SecretStore {
  readonly #byOperator = new Map<string, string>();

  /** Hold `password` for `operatorId`, replacing any password already held. */
  set(operatorId: string, password: string): void {
    this.#byOperator.set(operatorId, password);
  }

  /** The password held for `operatorId`, or `undefined` when none is. */
  get(operatorId: string): string | undefined {
    return this.#byOperator.get(operatorId);
  }

  /**
   * Drop any password held for `operatorId`; a no-op when none is. The login
   * session (#51) calls this when a served session expires or signs off, so a
   * locked-out session cannot re-sign from a password nobody re-entered.
   */
  clear(operatorId: string): void {
    this.#byOperator.delete(operatorId);
  }
}

/**
 * The one store the running process shares. The portal and the prompt fill it,
 * and `sessionEstablisherFor` reads it; a fresh `SecretStore` is passed in
 * instead only by tests that want isolation.
 */
export const secretStore = new SecretStore();
