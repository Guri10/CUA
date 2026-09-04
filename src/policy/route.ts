/**
 * What a URL means to the policy gate: whether the run may be there at all, and
 * whether being there can change anything.
 *
 * Deny by default. A route the profile does not classify is refused rather than
 * assumed safe — that is the difference between an allowlist and a blocklist
 * with gaps in it, and ADR 0007 asks for the former.
 */
import type { SurfaceProfile } from "./profile.js";
import { originOf } from "./profile.js";

export type RouteVerdict =
  | { readonly allowed: true; readonly route: string; readonly mutates: boolean }
  | { readonly allowed: false; readonly reason: string };

export function routeOf(profile: SurfaceProfile, url: string): RouteVerdict {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { allowed: false, reason: `"${url}" is not a URL.` };
  }

  if (!profile.allowedOrigins.some((allowed) => originOf(allowed) === parsed.origin)) {
    return {
      allowed: false,
      reason: `The origin ${parsed.origin} is not allowed by the "${profile.id}" Surface profile.`,
    };
  }

  const base = new URL(profile.baseUrl).pathname.replace(/\/+$/, "");
  // The token ParaBank puts in the path, and anything after it. Stripped before
  // the prefix check, because a session token can attach to any segment.
  const path = parsed.pathname.replace(/;[^/]*/g, "");
  if (!path.startsWith(`${base}/`)) {
    return {
      allowed: false,
      reason: `${path} is outside ${base || "/"}, which is where the "${profile.id}" installation lives.`,
    };
  }

  const route = path.slice(base.length);
  // Mutating is checked first so that if a concrete path could match a pattern
  // in either list, it is treated as the more restrictive one — the safe
  // direction to be wrong in.
  if (profile.routes.mutating.some((pattern) => matchesRoutePattern(route, pattern))) {
    return { allowed: true, route, mutates: true };
  }
  if (profile.routes["read-only"].some((pattern) => matchesRoutePattern(route, pattern))) {
    return { allowed: true, route, mutates: false };
  }

  return {
    allowed: false,
    reason: `"${route}" is not a route the "${profile.id}" Surface profile lists.`,
  };
}

/**
 * Whether a concrete route matches one of the profile's route patterns.
 *
 * A pattern is a path where a segment beginning with `:` is a parameter — it
 * matches any one non-empty segment (a member id, say), and the read/mutate
 * class comes from the literal verb segments around it, never from the value
 * the parameter took (ADR 0009). A pattern with no parameters — ParaBank's
 * flat `/transfer.htm` — is just a literal, so its match is exact equality and
 * those profiles are untouched.
 */
function matchesRoutePattern(route: string, pattern: string): boolean {
  const routeSegments = route.split("/");
  const patternSegments = pattern.split("/");
  if (routeSegments.length !== patternSegments.length) return false;
  return patternSegments.every((segment, i) => {
    const routeSegment = routeSegments[i];
    return segment.startsWith(":")
      ? routeSegment !== undefined && routeSegment.length > 0
      : segment === routeSegment;
  });
}
