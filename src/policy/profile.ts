/**
 * The Surface profile: everything true of one installation of the application
 * rather than of any one Capability driving it.
 *
 * ADR 0005 puts it at this scope on purpose. Onboarding a Tenant running the
 * same vendor product means writing a new profile, not re-recording its
 * Capabilities — and the conditions every Capability shares, session expiry and
 * the login interstitial among them, are described here once instead of copied
 * into each Recording.
 *
 * It is a checked-in file rather than environment because of what it carries.
 * The allowlist is a safety rule, and ADR 0007 asks for one "a reviewer can
 * check in ten seconds" — which means it has to be somewhere a reviewer reads,
 * in a diff, rather than assembled from variables at run time.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { inputReferencesInPredicate, predicateSchema } from "../capability/schema.js";
import { packageRootFrom } from "../package-root.js";

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** A route as the profile lists it: rooted, and relative to the base URL. */
const ROUTE = /^\/[^\s?#;]*$/;
/** A Recoverable Condition reads as a constant where it is reported: `SESSION_EXPIRED`. */
const CONDITION_NAME = /^[A-Z][A-Z0-9_]*$/;

/**
 * The Action verbs this installation permits at all.
 *
 * Separate from what the Surface can do, because they answer different
 * questions: `Action` is what the seam supports, this is what we allow to be
 * done to *this* application.
 */
export const ACTION_KINDS = ["navigate", "click", "fill", "select", "read", "waitFor"] as const;

/**
 * A Recoverable Condition: a state of the application that Replay absorbs and
 * continues through, rather than an answer to anything or a reason to stop.
 *
 * Recognised the same way a Terminal State is — a predicate over the
 * accessibility tree — so that "the application is showing its login screen
 * instead of what was asked for" is written in the one vocabulary ADR 0001
 * allows, and matched by the same resolver.
 *
 * `recover` has one value today, and the reason is worth writing down rather
 * than leaving as an apparent oversight. ADR 0005 names three kinds of
 * Recoverable Condition; the other two need no entry here. A slow load is
 * waited out by the Step that is waiting for the control, which is where a wait
 * belongs and where its timeout is already declared. An interstitial to dismiss
 * would be a list of Actions — and ParaBank has none, so writing the variant
 * now would be writing config nothing serves. Adding either is additive.
 */
export const recoverableConditionSchema = z.object({
  name: z.string().regex(CONDITION_NAME),
  when: predicateSchema,
  /**
   * How to absorb it. Re-establishing a session needs credentials, which ADR
   * 0006 classes a Secret and no checked-in file holds — so the profile says
   * that this is what the condition needs, and the caller supplies the doing.
   */
  recover: z.enum(["re-establish-session"]),
});

export type RecoverableCondition = z.infer<typeof recoverableConditionSchema>;

export const surfaceProfileSchema = z
  .object({
    /** Matches the `surface` field of every Capability that runs against it. */
    id: z.string().regex(SLUG),
    /** The installation. A Recording stores paths; this is what they hang off. */
    baseUrl: z.url(),
    /**
     * Origins the automation may reach at all — user story 23, "refuse to
     * navigate outside an explicit allowlist, so that automation cannot wander
     * into applications it was never authorised for".
     */
    allowedOrigins: z.array(z.url()).min(1),
    actions: z.array(z.enum(ACTION_KINDS)).min(1),
    /**
     * Every route the automation may reach, split by whether reaching it can
     * change anything. A path in neither list is refused: deny-by-default is
     * what makes this an allowlist rather than a blocklist with gaps.
     */
    routes: z.object({
      "read-only": z.array(z.string().regex(ROUTE)),
      mutating: z.array(z.string().regex(ROUTE)),
    }),
    /**
     * The states this installation gets into that are nobody's answer and
     * nobody's fault — ADR 0005 puts them here rather than on each Capability,
     * because session expiry is a property of ParaBank shared by every
     * Capability driving it. Declared once, they cannot drift between copies,
     * and a new Tenant gets them by writing a profile rather than by
     * re-recording anything.
     *
     * Empty by default: an installation nobody has studied yet declares no
     * condition, and every unrecognised screen is a Hard Failure. That is the
     * safe direction to be wrong in.
     */
    recoverableConditions: z.array(recoverableConditionSchema).default([]),
  })
  .superRefine((profile, ctx) => {
    // A path in both lists has no answer to "may this run touch it", and which
    // answer a reader guesses depends on which list they read first.
    const readOnly = new Set(profile.routes["read-only"]);
    for (const route of profile.routes.mutating) {
      if (!readOnly.has(route)) continue;
      ctx.addIssue({
        code: "custom",
        path: ["routes"],
        message: `Route "${route}" is listed as both read-only and mutating.`,
      });
    }

    // A condition nobody can tell from another one in a report, and a run that
    // absorbed "one of the two SESSION_EXPIREDs" tells a reader nothing.
    const names = new Set<string>();
    for (const condition of profile.recoverableConditions) {
      if (names.has(condition.name)) {
        ctx.addIssue({
          code: "custom",
          path: ["recoverableConditions"],
          message: `Recoverable Condition "${condition.name}" is declared more than once.`,
        });
      }
      names.add(condition.name);

      // The profile describes the installation, and nothing at that scope knows
      // what any one Capability's inputs are. A predicate reaching for one
      // would be a condition that could only be matched during some runs.
      for (const reference of inputReferencesInPredicate(condition.when)) {
        ctx.addIssue({
          code: "custom",
          path: ["recoverableConditions"],
          message: `Recoverable Condition "${condition.name}" refers to input "${reference}"; a Surface profile describes the installation, not any one Capability's inputs.`,
        });
      }
    }

    // The one contradiction that would make every run fail at Step one.
    const origin = originOf(profile.baseUrl);
    if (origin !== undefined && !profile.allowedOrigins.map(originOf).includes(origin)) {
      ctx.addIssue({
        code: "custom",
        path: ["baseUrl"],
        message: `The base URL's origin ${origin} is not in allowedOrigins.`,
      });
    }
  });

export type SurfaceProfile = z.infer<typeof surfaceProfileSchema>;

/** Where this repository keeps its committed Surface profiles. */
export function surfacesDir(): string {
  return join(packageRootFrom(import.meta.url), "surfaces");
}

export async function loadSurfaceProfile(root: string, id: string): Promise<SurfaceProfile> {
  const path = join(root, `${id}.json`);

  let contents: string;
  try {
    contents = await readFile(path, "utf8");
  } catch {
    throw new Error(`No Surface profile "${id}" at ${path}.`);
  }

  const result = surfaceProfileSchema.safeParse(JSON.parse(contents));
  if (result.success) return result.data;

  const reasons = result.error.issues
    .map((issue) => `  ${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("\n");
  throw new Error(`${path} is not a valid Surface profile:\n${reasons}`);
}

export function originOf(url: string): string | undefined {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}
