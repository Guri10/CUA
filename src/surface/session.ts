/**
 * Establishing a session on whichever installation a Capability targets.
 *
 * Signing in is a property of the installation, not of any Recording (see
 * `cli.ts`), and each installation signs in differently — ParaBank by username,
 * MERIDIAN by operator id, password, and branch. This is the one place that maps
 * a Surface profile to its sign-on, so adapting to a new target is a branch here
 * plus its login builder, never a change to the executor or any Recording — the
 * sign-on half of "a new profile plus a small documented adapter" (#18, ADR 0009).
 *
 * The credentials are the one part a checked-in file cannot hold (ADR 0006): the
 * password is a Secret. For MERIDIAN it is read from the in-memory secret store
 * (#42), keyed by the non-secret operator id, so it can be supplied once by the
 * portal (#44) or a hidden prompt (#45) and never touches a command line; for
 * ParaBank it is still read from the environment. Either way it is never written.
 */
import { logInToParabank, type ParabankCredentials } from "./parabank/login.js";
import { logInToMeridian, type MeridianCredentials } from "./meridian/login.js";
import { secretStore, type SecretStore } from "./secret-store.js";
import { describeMiss } from "../replay/describe.js";
import type { SurfaceProfile } from "../policy/profile.js";
import type { Action, Surface } from "./surface.js";

export interface SessionEstablisher {
  /** The application password (ADR 0006 Secret), for this run's evidence redaction. */
  readonly secret: string;
  /** Sign in on a Surface that has no session yet. */
  establish(surface: Surface, baseUrl: string): Promise<void>;
}

/**
 * The sign-on for a Surface, keyed by its profile id.
 *
 * A profile naming a surface with no sign-on here throws now — before a browser
 * opens — rather than letting the run reach the login screen with no idea how to
 * fill it and report a mystified miss. Deny-by-default, the same direction the
 * route allowlist and the recoverable conditions are wrong in.
 */
export function sessionEstablisherFor(
  profile: SurfaceProfile,
  store: SecretStore = secretStore,
): SessionEstablisher {
  switch (profile.id) {
    case "meridian": {
      const credentials = meridianCredentials(store);
      return {
        secret: credentials.password,
        establish: (surface, baseUrl) => signIn(surface, baseUrl, logInToMeridian(baseUrl, credentials)),
      };
    }
    case "parabank": {
      const credentials = parabankCredentialsFromEnv();
      return {
        secret: credentials.password,
        establish: (surface, baseUrl) => signIn(surface, baseUrl, logInToParabank(baseUrl, credentials)),
      };
    }
    default:
      throw new Error(`No sign-on is configured for the "${profile.id}" surface.`);
  }
}

/**
 * Signing in before Step one. The executor is handed a Surface that already has a
 * session and knows nothing about how it got one — which is what keeps login out
 * of every Recording. A miss is a Hard Failure here and now: a run that could not
 * sign in has nothing to recover to.
 */
async function signIn(surface: Surface, baseUrl: string, actions: readonly Action[]): Promise<void> {
  for (const action of actions) {
    const result = await surface.perform(action);
    if (result.kind === "ok") continue;
    throw new Error(`Could not sign in to ${baseUrl}: ${describeMiss(result)}`);
  }
}

/**
 * Read before a browser launches, for the same reason inputs are checked there: a
 * missing `.env` should cost a sentence, not a Chromium.
 */
function parabankCredentialsFromEnv(): ParabankCredentials {
  return {
    username: requiredEnv("PARABANK_USERNAME"),
    // ADR 0006 classes this a Secret: handed in at run time, never written.
    password: requiredEnv("PARABANK_PASSWORD"),
  };
}

function meridianCredentials(store: SecretStore): MeridianCredentials {
  // Non-secret: the caller passes it, and the password is looked up by it.
  const operator = requiredEnv("MERIDIAN_OPERATOR");
  return {
    operator,
    // ADR 0006 Secret, read from the in-memory store keyed by the operator id (#42).
    password: meridianPassword(store, operator),
    // The whole branch label the sign-on combobox renders, e.g. "MAIN-001 - Main Office".
    branch: requiredEnv("MERIDIAN_BRANCH"),
  };
}

/**
 * The Operator's password, from the in-memory store (#42).
 *
 * The store is the source: the portal (#44) and the hidden prompt (#45) fill it,
 * and a run signs on with whatever it holds for this operator. Until those land,
 * a `MERIDIAN_PASSWORD` in the environment seeds the store once so live runs and
 * the e2e suite keep working — a bridge for #45 to replace with the prompt, not a
 * second lasting source. Env is a Secret handed in at run time, never written
 * (ADR 0006), so seeding from it keeps the "never on a command line" guarantee.
 */
function meridianPassword(store: SecretStore, operator: string): string {
  const held = store.get(operator);
  if (held !== undefined) return held;

  const fromEnv = process.env["MERIDIAN_PASSWORD"];
  if (fromEnv !== undefined && fromEnv !== "") {
    store.set(operator, fromEnv);
    return fromEnv;
  }

  throw new Error(
    `No password for operator "${operator}" in the secret store, ` +
      `and MERIDIAN_PASSWORD is not set. Sign on through the portal or set MERIDIAN_PASSWORD.`,
  );
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`${name} is not set. Copy .env.example to .env and fill it in.`);
  }
  return value;
}
