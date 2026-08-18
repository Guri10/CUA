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
  if (profile.routes.mutating.includes(route)) {
    return { allowed: true, route, mutates: true };
  }
  if (profile.routes["read-only"].includes(route)) {
    return { allowed: true, route, mutates: false };
  }

  return {
    allowed: false,
    reason: `"${route}" is not a route the "${profile.id}" Surface profile lists.`,
  };
}
