import { describe, expect, it } from "vitest";
import { SecretStore } from "./secret-store.js";

/**
 * The store is the one place an Operator's password lives at run time, keyed by
 * the non-secret operator id (#42). What is proven here is the plain contract
 * the session and the portal both depend on: what goes in under an id comes back
 * out under that id, and nothing else.
 */
describe("the in-memory secret store", () => {
  it("gets back the password it was set for an operator", () => {
    const store = new SecretStore();
    store.set("super1", "a-secret");

    expect(store.get("super1")).toBe("a-secret");
  });

  it("returns undefined for an operator it holds no password for", () => {
    const store = new SecretStore();
    store.set("super1", "a-secret");

    // A different operator, and one never set at all, both read as "no password".
    expect(store.get("teller1")).toBeUndefined();
    expect(store.get("nobody")).toBeUndefined();
  });

  it("replaces the password when the same operator is set again", () => {
    const store = new SecretStore();
    store.set("super1", "old-secret");
    store.set("super1", "new-secret");

    expect(store.get("super1")).toBe("new-secret");
  });

  it("holds each operator's password separately", () => {
    const store = new SecretStore();
    store.set("teller1", "teller-secret");
    store.set("super1", "super-secret");

    expect(store.get("teller1")).toBe("teller-secret");
    expect(store.get("super1")).toBe("super-secret");
  });
});
