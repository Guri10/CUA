/**
 * The real sign-on validator: the one that drives a browser (#44).
 *
 * "Validate the credentials once by establishing a session" is taken literally —
 * it opens a gated Surface and runs MERIDIAN's own sign-on with the submitted
 * operator, branch, and password, exactly as a replay would before Step one. If
 * the flow reaches MAIN MENU the credentials are good and the Operator's role is
 * read off the post-login banner (ADR 0008); if any Step misses — a wrong
 * password never reaches the menu — it throws with a clear message and the portal
 * turns the submission away, having stored nothing.
 *
 * The Surface comes from the one gated factory (ADR 0007), so the sign-on is
 * logged like any other screen interaction, and the password is registered as an
 * ADR 0006 Secret on the evidence run so it is redacted rather than written. The
 * message on a miss describes the missing step, never the password.
 */
import { EvidenceRun } from "../evidence/run.js";
import { openBrowserSurface } from "../policy/open-surface.js";
import type { SurfaceProfile } from "../policy/profile.js";
import { logInToMeridian, readOperatorRole } from "../surface/meridian/login.js";
import { describeMiss } from "../replay/describe.js";
import type { SignOn } from "./serve.js";

export interface BrowserSignOnOptions {
  /** The Surface profile to sign into — the portal is MERIDIAN's, so its profile. */
  readonly profile: SurfaceProfile;
  /** Where the installation is, resolved once by the command. */
  readonly baseUrl: string;
  /** The directory evidence runs are kept under. */
  readonly evidenceRoot: string;
  /** Whether evidence masks Sensitive values; Secrets are stripped regardless. */
  readonly masking: "on" | "off";
  /** Headed by default so a person can see the sign-on; tests pass true. */
  readonly headless?: boolean;
}

export function browserSignOn(options: BrowserSignOnOptions): SignOn {
  return async ({ operator, branch, password }) => {
    // The password is a Secret on this run's evidence, so signing on is logged
    // without the password ever being written (ADR 0006).
    const evidence = await EvidenceRun.start({
      root: options.evidenceRoot,
      label: "signon",
      about: { baseUrl: options.baseUrl, operator },
      redaction: { secrets: [password], sensitive: [], masking: options.masking },
    });

    // Signing on touches only read-only routes, so the mandate never grants a
    // mutating one — the gate refuses one regardless of what the login builder asks.
    const { surface, close } = await openBrowserSurface(
      options.profile,
      { mayMutate: false },
      evidence,
      { headless: options.headless ?? false },
    );

    try {
      for (const action of logInToMeridian(options.baseUrl, { operator, password, branch })) {
        const result = await surface.perform(action);
        if (result.kind !== "ok") {
          await evidence.captureFailure(await surface.screenshot());
          await evidence.finish("hard-failure", { step: "sign-on" });
          // describeMiss names the step that missed, not the password.
          throw new Error(`Sign-on failed: ${describeMiss(result)}`);
        }
      }

      // Reached MAIN MENU. The role is the target's own assertion off the banner,
      // advisory per ADR 0008 — undefined when the banner is shaped differently.
      const role = readOperatorRole((await surface.snapshot()).tree);
      await evidence.finish("success", {});
      return { operator, ...(role !== undefined ? { role } : {}) };
    } finally {
      await close();
    }
  };
}
