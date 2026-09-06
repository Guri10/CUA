/**
 * The gated login session for the served app (#51).
 *
 * `serve` used to be always-open and locked to one operator by the environment.
 * This in-memory receipt replaces both. A person signs on at the portal, which
 * marks this live and records who they are; the catalog and chatbot refuse until
 * it is live; and each served interaction that is admitted resets an idle clock.
 * When the clock runs out, or the person signs off, the session is cleared and the
 * operator's password is dropped from the secret store — so the next interaction
 * is locked out until a fresh portal sign-on.
 *
 * It holds no password of its own (that stays in the `SecretStore`, ADR 0006); it
 * holds who is signed on, the branch they chose, and when they were last active.
 * One operator per process: the first sign-on locks the operator for the life of
 * the run, so a later sign-on as a *different* operator is refused until restart —
 * a re-sign as the same operator (after an idle timeout, say) is fine.
 *
 * There is no browser kept alive here. "Signed on" is a receipt, not a live
 * browser session: every invoke still opens its own browser and signs on from the
 * stored password (`session.ts`). This only decides whether that is allowed, and
 * as whom.
 */
import { secretStore, type SecretStore } from "./secret-store.js";

/** Who a served run signs on as: the non-secret operator id and the branch label. */
export interface OperatorIdentity {
  readonly operator: string;
  readonly branch: string;
}

export interface LoginSessionOptions {
  /** How long, in milliseconds, with no admitted interaction before it expires. */
  readonly idleMs: number;
  /** The store to drop the password from on expiry or sign-off. Defaults to the shared one. */
  readonly store?: SecretStore;
  /** The clock, injectable so tests need not wait. Defaults to `Date.now`. */
  readonly now?: () => number;
}

export class LoginSession {
  readonly #idleMs: number;
  readonly #store: SecretStore;
  readonly #now: () => number;
  /** The operator this process locked onto at its first sign-on; never changes after. */
  #lockedOperator: string | undefined;
  #active: { operator: string; branch: string; lastActivityAt: number } | undefined;

  constructor(options: LoginSessionOptions) {
    this.#idleMs = options.idleMs;
    this.#store = options.store ?? secretStore;
    this.#now = options.now ?? Date.now;
  }

  /** The operator this process is locked to once anyone has signed on, else undefined. */
  lockedOperator(): string | undefined {
    return this.#lockedOperator;
  }

  /** Whether `operator` may sign on: the locked one, or any when none is locked yet. */
  accepts(operator: string): boolean {
    return this.#lockedOperator === undefined || this.#lockedOperator === operator;
  }

  /**
   * Record a validated sign-on and start the session live. Throws if a *different*
   * operator is already locked for this process (one operator per boot).
   */
  signOn(identity: OperatorIdentity, now: number = this.#now()): void {
    if (!this.accepts(identity.operator)) {
      throw new Error(
        `This installation is signed on as operator "${this.#lockedOperator}" until it restarts. ` +
          `Sign on as "${this.#lockedOperator}", or restart to change operator.`,
      );
    }
    this.#lockedOperator = identity.operator;
    this.#active = { operator: identity.operator, branch: identity.branch, lastActivityAt: now };
  }

  /** The identity a served run should sign on as, or undefined when not live. */
  identity(now: number = this.#now()): OperatorIdentity | undefined {
    this.#expireIfIdle(now);
    return this.#active === undefined
      ? undefined
      : { operator: this.#active.operator, branch: this.#active.branch };
  }

  /** Whether a live (non-expired) session exists right now; expires it if idle. */
  isLive(now: number = this.#now()): boolean {
    this.#expireIfIdle(now);
    return this.#active !== undefined;
  }

  /**
   * Gate one served interaction: when live, reset the idle clock and allow it;
   * otherwise refuse. The single call the catalog and chatbot make per request.
   */
  admit(now: number = this.#now()): boolean {
    this.#expireIfIdle(now);
    if (this.#active === undefined) return false;
    this.#active.lastActivityAt = now;
    return true;
  }

  /** End the session now: clear it and drop the password. The operator lock is kept. */
  signOff(): void {
    this.#clear();
  }

  /** Expire and clear the session when it has been idle past the timeout. */
  #expireIfIdle(now: number): void {
    if (this.#active !== undefined && now - this.#active.lastActivityAt > this.#idleMs) {
      this.#clear();
    }
  }

  #clear(): void {
    if (this.#active !== undefined) this.#store.clear(this.#active.operator);
    this.#active = undefined;
  }
}
