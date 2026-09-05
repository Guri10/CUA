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
 * Which outcome a member-lookup Replay should reach: the one row a unique match
 * shows, the several rows several matches show, or the empty result no match
 * shows. The three are different scripts, not one screen read three ways — the
 * fake fires a transition on the control acted on, so the Search click leads to
 * whichever result screen this outcome names.
 */
export type MemberLookupOutcome = "unique" | "multiple" | "none";

/**
 * The member-inquiry screens, wired for one outcome.
 *
 * Every tree is a real capture (`members-search`, `members-unique`,
 * `members-candidates`, `members-not-found`, and the `member-100234` record a
 * unique match leads to). The Search click always moves off the form to a result
 * screen; only the unique result carries a further transition, because only there
 * does clicking "Select" resolve to one link and lead on to the record. On the
 * several-matches screen the "Select" Locator is ambiguous and the click simply
 * misses, which is exactly what leaves the run standing on the candidate list.
 */
export function meridianMemberLookupScript(outcome: MemberLookupOutcome): Script {
  const search: ScriptedScreen = {
    name: "search",
    url: `${MERIDIAN_CAPTURED_BASE_URL}/members`,
    tree: capturedMeridianTree("members-search"),
    transitions: [
      { when: { kind: "click", locator: { role: "button", name: "Search" } }, to: "result" },
    ],
  };

  if (outcome === "unique") {
    return {
      screens: [
        search,
        {
          name: "result",
          url: `${MERIDIAN_CAPTURED_BASE_URL}/members?by=number&q=${CAPTURED_MEMBER}`,
          tree: capturedMeridianTree("members-unique"),
          transitions: [
            { when: { kind: "click", locator: { role: "link", name: "Select", exact: true } }, to: "record" },
          ],
        },
        {
          name: "record",
          url: `${MERIDIAN_CAPTURED_BASE_URL}/members/${CAPTURED_MEMBER}`,
          tree: capturedMeridianTree(`member-${CAPTURED_MEMBER}`),
        },
      ],
    };
  }

  const result =
    outcome === "multiple"
      ? { slug: "members-candidates", url: `${MERIDIAN_CAPTURED_BASE_URL}/members?by=name&q=o` }
      : { slug: "members-not-found", url: `${MERIDIAN_CAPTURED_BASE_URL}/members?by=number&q=999999` };

  return {
    screens: [
      search,
      { name: "result", url: result.url, tree: capturedMeridianTree(result.slug) },
    ],
  };
}

/**
 * Which ending a funds-transfer Replay should reach: the posted confirmation, or
 * one of the two refusals the review step turns a bad request back with. The
 * three are different scripts, not one screen read three ways — the fake fires a
 * transition on the control acted on, so the "Continue" click leads to whichever
 * screen this outcome names, exactly as the member-lookup outcomes do.
 */
export type FundsTransferOutcome = "posted" | "source-on-hold" | "insufficient-funds";

/**
 * The transfer screens, wired for one outcome.
 *
 * Every tree is a real capture. The flow reaches the form the long way — search,
 * the unique result, the record, then the record's "Funds Transfer" link — so
 * the same `members-search` / `members-unique` / `member-100234` captures the
 * lookup Capabilities use are reused here. On the form the "Continue" click leads
 * to the review on the `posted` path and straight to a refusal screen on the
 * other two; only the review carries a further "Post Transfer" transition, to the
 * posted confirmation.
 */
export function meridianTransferScript(outcome: FundsTransferOutcome): Script {
  const member = CAPTURED_MEMBER;
  const search: ScriptedScreen = {
    name: "search",
    url: `${MERIDIAN_CAPTURED_BASE_URL}/members`,
    tree: capturedMeridianTree("members-search"),
    transitions: [
      { when: { kind: "click", locator: { role: "button", name: "Search" } }, to: "result" },
    ],
  };
  const result: ScriptedScreen = {
    name: "result",
    url: `${MERIDIAN_CAPTURED_BASE_URL}/members?by=number&q=${member}`,
    tree: capturedMeridianTree("members-unique"),
    transitions: [
      { when: { kind: "click", locator: { role: "link", name: "Select", exact: true } }, to: "record" },
    ],
  };
  const record: ScriptedScreen = {
    name: "record",
    url: `${MERIDIAN_CAPTURED_BASE_URL}/members/${member}`,
    tree: capturedMeridianTree(`member-${member}`),
    transitions: [
      {
        when: { kind: "click", locator: { role: "link", name: "Funds Transfer", exact: true } },
        to: "form",
      },
    ],
  };

  const form: ScriptedScreen = {
    name: "form",
    url: `${MERIDIAN_CAPTURED_BASE_URL}/members/${member}/transfer`,
    tree: capturedMeridianTree("transfer"),
    transitions: [
      {
        when: { kind: "click", locator: { role: "button", name: "Continue" } },
        // The review on the posted path; the refusal screen on the others.
        to: outcome === "posted" ? "review" : "outcome",
      },
    ],
  };

  const prefix = [search, result, record, form];

  if (outcome === "posted") {
    return {
      screens: [
        ...prefix,
        {
          name: "review",
          url: `${MERIDIAN_CAPTURED_BASE_URL}/members/${member}/transfer/review`,
          tree: capturedMeridianTree("transfer-review"),
          transitions: [
            {
              when: { kind: "click", locator: { role: "button", name: "Post Transfer" } },
              to: "posted",
            },
          ],
        },
        {
          name: "posted",
          url: `${MERIDIAN_CAPTURED_BASE_URL}/members/${member}/transfer/post`,
          tree: capturedMeridianTree("transfer-complete"),
        },
      ],
    };
  }

  const slug =
    outcome === "source-on-hold" ? "transfer-source-on-hold" : "transfer-insufficient-funds";
  return {
    screens: [
      ...prefix,
      {
        name: "outcome",
        url: `${MERIDIAN_CAPTURED_BASE_URL}/members/${member}/transfer/review`,
        tree: capturedMeridianTree(slug),
      },
    ],
  };
}

/**
 * Which ending a place-hold Replay should reach: the applied confirmation a
 * supervisor session posts, or the supervisor-override-required screen a teller
 * session is stopped at. As with the transfer outcomes these are different
 * scripts — the "Continue" click leads to whichever screen the session's
 * authority would actually produce.
 */
export type PlaceHoldOutcome = "applied" | "override-required";

/**
 * The hold screens, wired for one outcome.
 *
 * Every tree is a real capture. The flow reaches the form the long way — search,
 * the unique result, the record, then the record's "Place Account Hold" link — so
 * the same lookup captures are reused. On the form "Continue" leads to the review
 * on the `applied` path and to the override screen on the other; only the review
 * carries a further "Apply Hold" transition, to the applied confirmation.
 */
export function meridianHoldScript(outcome: PlaceHoldOutcome): Script {
  const member = CAPTURED_MEMBER;
  const search: ScriptedScreen = {
    name: "search",
    url: `${MERIDIAN_CAPTURED_BASE_URL}/members`,
    tree: capturedMeridianTree("members-search"),
    transitions: [
      { when: { kind: "click", locator: { role: "button", name: "Search" } }, to: "result" },
    ],
  };
  const result: ScriptedScreen = {
    name: "result",
    url: `${MERIDIAN_CAPTURED_BASE_URL}/members?by=number&q=${member}`,
    tree: capturedMeridianTree("members-unique"),
    transitions: [
      { when: { kind: "click", locator: { role: "link", name: "Select", exact: true } }, to: "record" },
    ],
  };
  const record: ScriptedScreen = {
    name: "record",
    url: `${MERIDIAN_CAPTURED_BASE_URL}/members/${member}`,
    tree: capturedMeridianTree(`member-${member}`),
    transitions: [
      {
        when: { kind: "click", locator: { role: "link", name: "Place Account Hold", exact: true } },
        to: "form",
      },
    ],
  };
  const form: ScriptedScreen = {
    name: "form",
    url: `${MERIDIAN_CAPTURED_BASE_URL}/members/${member}/hold`,
    tree: capturedMeridianTree("hold"),
    transitions: [
      {
        when: { kind: "click", locator: { role: "button", name: "Continue" } },
        to: outcome === "applied" ? "review" : "outcome",
      },
    ],
  };

  const prefix = [search, result, record, form];

  if (outcome === "applied") {
    return {
      screens: [
        ...prefix,
        {
          name: "review",
          url: `${MERIDIAN_CAPTURED_BASE_URL}/members/${member}/hold/review`,
          tree: capturedMeridianTree("hold-review"),
          transitions: [
            {
              when: { kind: "click", locator: { role: "button", name: "Apply Hold" } },
              to: "applied",
            },
          ],
        },
        {
          name: "applied",
          url: `${MERIDIAN_CAPTURED_BASE_URL}/members/${member}/hold/post`,
          tree: capturedMeridianTree("hold-complete"),
        },
      ],
    };
  }

  return {
    screens: [
      ...prefix,
      {
        name: "outcome",
        url: `${MERIDIAN_CAPTURED_BASE_URL}/members/${member}/hold/review`,
        tree: capturedMeridianTree("hold-override-required"),
      },
    ],
  };
}

/**
 * Which ending an open-share Replay should reach: the opened confirmation, or
 * the minimum-deposit refusal the review step turns a bad request back with. As
 * with the transfer and hold outcomes these are different scripts — the
 * "Continue" click leads to whichever screen the deposit would actually produce.
 */
export type OpenShareOutcome = "opened" | "min-deposit";

/**
 * The open-share screens, wired for one outcome.
 *
 * Every tree is a real capture. The flow reaches the form the long way — search,
 * the unique result, the record, then the record's "Open New Share" link — so the
 * same lookup captures are reused. On the form "Continue" leads to the review on
 * the `opened` path and to the minimum-deposit refusal on the other; only the
 * review carries a further "Open Share" transition, to the opened confirmation.
 */
export function meridianOpenShareScript(outcome: OpenShareOutcome): Script {
  const member = CAPTURED_MEMBER;
  const search: ScriptedScreen = {
    name: "search",
    url: `${MERIDIAN_CAPTURED_BASE_URL}/members`,
    tree: capturedMeridianTree("members-search"),
    transitions: [
      { when: { kind: "click", locator: { role: "button", name: "Search" } }, to: "result" },
    ],
  };
  const result: ScriptedScreen = {
    name: "result",
    url: `${MERIDIAN_CAPTURED_BASE_URL}/members?by=number&q=${member}`,
    tree: capturedMeridianTree("members-unique"),
    transitions: [
      { when: { kind: "click", locator: { role: "link", name: "Select", exact: true } }, to: "record" },
    ],
  };
  const record: ScriptedScreen = {
    name: "record",
    url: `${MERIDIAN_CAPTURED_BASE_URL}/members/${member}`,
    tree: capturedMeridianTree(`member-${member}`),
    transitions: [
      {
        when: { kind: "click", locator: { role: "link", name: "Open New Share", exact: true } },
        to: "form",
      },
    ],
  };
  const form: ScriptedScreen = {
    name: "form",
    url: `${MERIDIAN_CAPTURED_BASE_URL}/members/${member}/open-share`,
    tree: capturedMeridianTree("open-share"),
    transitions: [
      {
        when: { kind: "click", locator: { role: "button", name: "Continue" } },
        to: outcome === "opened" ? "review" : "outcome",
      },
    ],
  };

  const prefix = [search, result, record, form];

  if (outcome === "opened") {
    return {
      screens: [
        ...prefix,
        {
          name: "review",
          url: `${MERIDIAN_CAPTURED_BASE_URL}/members/${member}/open-share/review`,
          tree: capturedMeridianTree("open-share-review"),
          transitions: [
            {
              when: { kind: "click", locator: { role: "button", name: "Open Share" } },
              to: "opened",
            },
          ],
        },
        {
          name: "opened",
          url: `${MERIDIAN_CAPTURED_BASE_URL}/members/${member}/open-share/post`,
          tree: capturedMeridianTree("open-share-complete"),
        },
      ],
    };
  }

  return {
    screens: [
      ...prefix,
      {
        name: "outcome",
        url: `${MERIDIAN_CAPTURED_BASE_URL}/members/${member}/open-share/review`,
        tree: capturedMeridianTree("open-share-min-deposit"),
      },
    ],
  };
}

/**
 * Which ending an update-member Replay should reach: the saved confirmation, or
 * one of the two validation refusals "Save Changes" turns a bad request back
 * with. update-member is single-step — there is no review — so "Save Changes"
 * leads straight to whichever screen this outcome names.
 */
export type UpdateMemberOutcome = "saved" | "invalid-email" | "invalid-phone";

/**
 * The update-member screens, wired for one outcome.
 *
 * Every tree is a real capture. The flow reaches the form the long way — search,
 * the unique result, the record, then the record's "Update Member Information"
 * link — so the same lookup captures are reused. On the form "Save Changes" leads
 * to the saved confirmation on the `saved` path and to a refusal screen on the
 * other two; there is no further transition, because there is no review step.
 */
export function meridianUpdateMemberScript(outcome: UpdateMemberOutcome): Script {
  const member = CAPTURED_MEMBER;
  const search: ScriptedScreen = {
    name: "search",
    url: `${MERIDIAN_CAPTURED_BASE_URL}/members`,
    tree: capturedMeridianTree("members-search"),
    transitions: [
      { when: { kind: "click", locator: { role: "button", name: "Search" } }, to: "result" },
    ],
  };
  const result: ScriptedScreen = {
    name: "result",
    url: `${MERIDIAN_CAPTURED_BASE_URL}/members?by=number&q=${member}`,
    tree: capturedMeridianTree("members-unique"),
    transitions: [
      { when: { kind: "click", locator: { role: "link", name: "Select", exact: true } }, to: "record" },
    ],
  };
  const record: ScriptedScreen = {
    name: "record",
    url: `${MERIDIAN_CAPTURED_BASE_URL}/members/${member}`,
    tree: capturedMeridianTree(`member-${member}`),
    transitions: [
      {
        when: { kind: "click", locator: { role: "link", name: "Update Member Information", exact: true } },
        to: "form",
      },
    ],
  };
  const form: ScriptedScreen = {
    name: "form",
    url: `${MERIDIAN_CAPTURED_BASE_URL}/members/${member}/update`,
    tree: capturedMeridianTree("update"),
    transitions: [
      {
        when: { kind: "click", locator: { role: "button", name: "Save Changes" } },
        to: "outcome",
      },
    ],
  };

  const slug =
    outcome === "saved"
      ? "update-complete"
      : outcome === "invalid-email"
        ? "update-invalid-email"
        : "update-invalid-phone";

  return {
    screens: [
      search,
      result,
      record,
      form,
      {
        name: "outcome",
        url: `${MERIDIAN_CAPTURED_BASE_URL}/members/${member}/update`,
        tree: capturedMeridianTree(slug),
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
