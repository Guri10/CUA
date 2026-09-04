/**
 * The scripted screens the fake Surface answers MERIDIAN Core from.
 *
 * The trees are not invented. They are the accessibility snapshots the real
 * browser produced and committed under `evidence/accessibility-tree/meridian/`,
 * read straight off disk — so the fake answers from the same trees the
 * application actually served, unnamed inputs and giant row names and all. A
 * hand-written tree would quietly describe the application we wish we had.
 *
 * Every tree is run through `redactSessionIds` on the way in (ADR 0006). The
 * committed captures already show `SID [REDACTED]`, so the pass is idempotent
 * here — but it is applied rather than assumed, so a freshly-captured tree
 * carrying a live `SID` never reaches a fixture, an assertion, or a diff.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { packageRootFrom } from "../../package-root.js";
import { redactSessionIds } from "../../evidence/redact-session-ids.js";
import { MERIDIAN_SIGN_ON_PATH } from "./login.js";
import type { Script, ScriptedScreen } from "../fake-surface.js";

/**
 * The address the committed snapshots were captured against. The fake replays
 * one recorded session, so its screens are only reachable at the addresses that
 * session used.
 */
export const MERIDIAN_CAPTURED_BASE_URL = "https://web-sample.interface-hiring.com";

/** The member the transfer, hold, and balance captures were taken against. */
export const CAPTURED_MEMBER = "100234";

/**
 * How a scripted sign-on ends: reaching the menu, or being turned back.
 *
 * The fake fires a transition on the control that was acted on, never on what
 * was typed into it, so success and rejection cannot be told apart by the
 * password — they are two different scripts. `rejected` simply omits the
 * sign-on transition, leaving the run on the sign-on screen, which is where a
 * turned-back operator actually stands and what BAD_LOGIN is a predicate over.
 */
export type SignOnOutcome = "succeeds" | "rejected";

export function meridianScript(outcome: SignOnOutcome = "succeeds"): Script {
  const signon: ScriptedScreen = {
    name: "signon",
    url: `${MERIDIAN_CAPTURED_BASE_URL}${MERIDIAN_SIGN_ON_PATH}`,
    tree: capturedMeridianTree("signon"),
    ...(outcome === "succeeds"
      ? {
          transitions: [
            { when: { kind: "click", locator: { role: "button", name: "Sign On" } }, to: "menu" },
          ],
        }
      : {}),
  };

  return {
    screens: [
      signon,
      {
        name: "menu",
        url: `${MERIDIAN_CAPTURED_BASE_URL}/menu`,
        tree: capturedMeridianTree("menu"),
      },
    ],
  };
}

/**
 * One committed MERIDIAN snapshot, by slug, scrubbed and with its `URL:` header
 * stripped.
 *
 * Exported because the fake is not the only thing checked against the screens
 * MERIDIAN actually served: the sign-on Capability's Locators are resolved
 * against these same trees before anyone claims they address a real control.
 */
export function capturedMeridianTree(slug: string): string {
  const raw = readFileSync(join(evidenceDir(), `${slug}.txt`), "utf8");
  return redactSessionIds(stripUrlHeader(raw));
}

/**
 * The captures carry a leading `URL: …` line for the reader; the screen's own
 * `url` is set from the script, so the header is dropped rather than parsed. It
 * is harmless if left (it matches no node line), but stripping it keeps the
 * tree the fake holds identical to the tree it renders.
 */
function stripUrlHeader(tree: string): string {
  return tree.replace(/^URL:.*\r?\n/, "");
}

function evidenceDir(): string {
  return join(packageRootFrom(import.meta.url), "evidence", "accessibility-tree", "meridian");
}
