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
 * password is a Secret, read from the environment at run time and never written.
 */
import { logInToParabank, type ParabankCredentials } from "./parabank/login.js";
import { logInToMeridian, type MeridianCredentials } from "./meridian/login.js";
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
export function sessionEstablisherFor(profile: SurfaceProfile): SessionEstablisher {
  switch (profile.id) {
    case "meridian": {
      const credentials = meridianCredentialsFromEnv();
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

function meridianCredentialsFromEnv(): MeridianCredentials {
  return {
    // Non-secret: the caller passes it and the password is looked up by it.
    operator: requiredEnv("MERIDIAN_OPERATOR"),
    // ADR 0006 Secret, as above.
    password: requiredEnv("MERIDIAN_PASSWORD"),
    // The whole branch label the sign-on combobox renders, e.g. "MAIN-001 - Main Office".
    branch: requiredEnv("MERIDIAN_BRANCH"),
  };
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`${name} is not set. Copy .env.example to .env and fill it in.`);
  }
  return value;
}
