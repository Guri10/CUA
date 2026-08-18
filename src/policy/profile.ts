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
import { packageRootFrom } from "../package-root.js";

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** A route as the profile lists it: rooted, and relative to the base URL. */
const ROUTE = /^\/[^\s?#;]*$/;

/**
 * The Action verbs this installation permits at all.
 *
 * Separate from what the Surface can do, because they answer different
 * questions: `Action` is what the seam supports, this is what we allow to be
 * done to *this* application.
 */
export const ACTION_KINDS = ["navigate", "click", "fill", "select", "read", "waitFor"] as const;

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
