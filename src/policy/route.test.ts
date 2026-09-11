import { describe, expect, it } from "vitest";
import { routeOf } from "./route.js";
import type { SurfaceProfile } from "./profile.js";

const profile: SurfaceProfile = {
  id: "parabank",
  baseUrl: "http://localhost:8080/parabank",
  allowedOrigins: ["http://localhost:8080"],
  actions: ["navigate", "click", "fill", "select", "read", "waitFor"],
  routes: { "read-only": ["/overview.htm", "/activity.htm"], mutating: ["/transfer.htm"] },
  recoverableConditions: [],
};

/**
 * Turning a URL the application actually served into the one question the
 * policy gate asks of it: may this run be here, and can being here change
 * anything.
 *
 * Pure, and table-driven below, because every entry is a way automation could
 * end up somewhere nobody authorised.
 */
describe("classifying a URL against a Surface profile", () => {
  it("recognises a route that only reads", () => {
    expect(routeOf(profile, "http://localhost:8080/parabank/overview.htm")).toEqual({
      allowed: true,
      route: "/overview.htm",
      mutates: false,
    });
  });

  it("recognises a route that mutates", () => {
    expect(routeOf(profile, "http://localhost:8080/parabank/transfer.htm")).toEqual({
      allowed: true,
      route: "/transfer.htm",
      mutates: true,
    });
  });

  it("looks past a query string", () => {
    // The account detail carries the account number as a parameter.
    expect(routeOf(profile, "http://localhost:8080/parabank/activity.htm?id=12345")).toMatchObject({
      allowed: true,
      route: "/activity.htm",
    });
  });

  it("looks past a session token in the path", () => {
    // ParaBank puts one there, so a gate that did not strip it would refuse
    // every route on the first request of a session.
    expect(
      routeOf(profile, "http://localhost:8080/parabank/overview.htm;jsessionid=ABC123"),
    ).toMatchObject({ allowed: true, route: "/overview.htm" });
  });

  it.each([
    [
      "an origin nobody allowed",
      "http://evil.test/parabank/overview.htm",
      /origin .*evil\.test.* is not allowed/,
    ],
    [
      "a path outside the installation",
      "http://localhost:8080/elsewhere/overview.htm",
      /outside .*\/parabank/,
    ],
    [
      "a route the profile does not list",
      "http://localhost:8080/parabank/admin.htm",
      /"\/admin\.htm" is not a route/,
    ],
    ["something that is not a URL at all", "overview.htm", /not a URL/],
  ])("refuses %s, and says why", (_, url, reason) => {
    const verdict = routeOf(profile, url);

    expect(verdict.allowed).toBe(false);
    expect(verdict.allowed === false && verdict.reason).toMatch(reason);
  });

  it("refuses an unlisted route rather than assuming it is safe", () => {
    // Deny by default is what makes this an allowlist. A route nobody has
    // classified is one nobody has decided about.
    expect(routeOf(profile, "http://localhost:8080/parabank/billpay.htm").allowed).toBe(false);
  });
});

/**
 * MERIDIAN parameterises its member-servicing routes by member number
 * (`/members/100234/transfer/review`), so the allowlist lists path *patterns*
 * with a `:id` parameter rather than one literal per member. A route's
 * read/mutate class is decided by its verb segments (`/transfer`, `/review`),
 * never by which member it names (ADR 0009).
 */
const meridian: SurfaceProfile = {
  id: "meridian",
  baseUrl: "https://meridian.test/console",
  allowedOrigins: ["https://meridian.test"],
  actions: ["navigate", "click", "fill", "select", "read", "waitFor"],
  routes: {
    "read-only": ["/members/:id", "/members/:id/balances"],
    mutating: ["/members/:id/transfer/review", "/members/:id/transfer/post"],
  },
  recoverableConditions: [],
};

describe("classifying a parameterised route against a Surface profile", () => {
  it("classifies a parameterised path by its pattern, whatever the id", () => {
    // Two different members, same route, same verdict — the id is data, not a
    // route, so it cannot change the read/mutate class.
    expect(routeOf(meridian, "https://meridian.test/console/members/100234/balances")).toEqual({
      allowed: true,
      route: "/members/100234/balances",
      mutates: false,
    });
    expect(routeOf(meridian, "https://meridian.test/console/members/999999/balances")).toEqual({
      allowed: true,
      route: "/members/999999/balances",
      mutates: false,
    });
  });

  it("lets the verb segments decide read vs mutate, not the id", () => {
    expect(
      routeOf(meridian, "https://meridian.test/console/members/100234/transfer/review"),
    ).toEqual({ allowed: true, route: "/members/100234/transfer/review", mutates: true });
  });

  it("looks past a session token attached to a parameter segment", () => {
    // The strip runs before matching, so a token on any segment — the id
    // included — does not stop the pattern from matching.
    expect(
      routeOf(meridian, "https://meridian.test/console/members/100234;jsessionid=ABC/balances"),
    ).toMatchObject({ allowed: true, route: "/members/100234/balances", mutates: false });
  });

  it("refuses a parameterised path no pattern classifies", () => {
    // Deny-by-default survives the move to patterns: an unlisted verb is still
    // refused, not assumed safe.
    expect(
      routeOf(meridian, "https://meridian.test/console/members/100234/close").allowed,
    ).toBe(false);
  });

  it("does not let a parameter swallow a differing segment count", () => {
    // `:id` matches exactly one segment; a path with an extra segment is a
    // different route and stays unclassified.
    expect(
      routeOf(meridian, "https://meridian.test/console/members/100234/balances/history").allowed,
    ).toBe(false);
  });
});
